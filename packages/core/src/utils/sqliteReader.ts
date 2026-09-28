/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite reader backed by the Node builtin `node:sqlite` module.
 *
 * `node:sqlite` is still flagged experimental and emits an `ExperimentalWarning`
 * when it is loaded, so the import above is deliberate and eager: a lazy
 * `createRequire` indirection only hid the warning from consumers that never
 * touch a database, at the cost of an untyped `require()` call.
 */

/** First 16 bytes of a SQLite 3 database file. */
const SQLITE_MAGIC = 'SQLite format 3\u0000';

/** Matches `foo.db`, `foo.sqlite`, `foo.sqlite3`, `foo.db3`. */
const SQLITE_PATH_PATTERN = /\.(?:sqlite3?|db3?)(?=(?::|\?|$))/i;

/** Only ever used to decide whether a target string is worth a selector parse. */
const SQLITE_PATH_SUFFIX = /\.(?:sqlite3?|db3?)$/i;

const DEFAULT_QUERY_LIMIT = 20;
const DEFAULT_SCHEMA_SAMPLE_LIMIT = 5;
const MAX_QUERY_LIMIT = 500;
/** Cap on the number of tables listed by the bare `db.sqlite` selector. */
export const MAX_LISTED_TABLES = 500;
/** Row cap for raw `?q=` SQL — protects against `SELECT *` on huge tables. */
export const SQLITE_MAX_ROWS = 1000;

/** Rows scanned before a listing falls back to a lower-bound / estimate count. */
const ROW_COUNT_PROBE_CAP = 50_000;

const MAX_RENDER_WIDTH = 120;
const MAX_COLUMN_WIDTH = 40;
/** Floor for each ASCII-table column. */
const MIN_COLUMN_WIDTH = 3;
/** Separator overhead per column in the ASCII table (`" | "`). */
const COLUMN_SEPARATOR_WIDTH = 3;
/** Constant frame overhead added once to every row. */
const TABLE_FRAME_WIDTH = 1;

const BUSY_TIMEOUT_MS = 3000;

/** Value shape a rendered cell may hold once stringified. */
type CellValue =
  | string
  | number
  | null
  | bigint
  | Uint8Array
  | boolean
  | undefined;

export interface SqliteSelector {
  kind: 'list' | 'schema' | 'row' | 'query' | 'raw';
  /** Table name for `schema`, `row`, `query`, and `raw` (`?raw=true`). */
  table?: string;
  /** Primary-key / rowid value for `row`. */
  key?: string;
  limit?: number;
  offset?: number;
  /** `column` or `column:desc`. */
  order?: string;
  /** Pre-validated predicate body (no `WHERE` keyword). */
  where?: string;
  /** Raw SQL for `raw`. Absent for the `?raw=true` sqlite_master dump. */
  sql?: string;
}

/** Returns true when the path carries a SQLite file extension. */
export function looksLikeSqlitePath(filePath: string): boolean {
  return (
    SQLITE_PATH_PATTERN.test(filePath) || SQLITE_PATH_SUFFIX.test(filePath)
  );
}

/** Cheap header sniff: confirms the file actually is a SQLite 3 database. */
function isSqliteFile(filePath: string): boolean {
  try {
    const handle = readFileSync(filePath);
    return (
      handle.subarray(0, SQLITE_MAGIC.length).toString('latin1') ===
      SQLITE_MAGIC
    );
  } catch {
    return false;
  }
}

function splitSqliteRemainder(remainder: string): {
  subPath: string;
  queryString: string;
} {
  const queryIndex = remainder.indexOf('?');
  if (queryIndex === -1) {
    return { subPath: remainder.replace(/^:+/, ''), queryString: '' };
  }
  return {
    subPath: remainder.slice(0, queryIndex).replace(/^:+/, ''),
    queryString: remainder.slice(queryIndex + 1),
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sanitizeCell(value: string): string {
  return value.replaceAll('\t', '  ').replaceAll(/\r?\n/g, '\\n');
}

/**
 * Visible width. SQLite text is arbitrary UTF-8; the grapheme-aware width used
 * by the source implementation is not available outside Bun, so full-width
 * code points are counted as two cells and everything else as one.
 */
function cellWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff)
        ? 2
        : 1;
  }
  return width;
}

function truncateToWidth(value: string, width: number): string {
  if (cellWidth(value) <= width) {
    return value;
  }
  if (width <= 1) {
    return '…';
  }
  let out = '';
  let used = 0;
  for (const char of value) {
    const charWidth = cellWidth(char);
    if (used + charWidth > width - 1) {
      break;
    }
    out += char;
    used += charWidth;
  }
  return `${out}…`;
}

function stringifyValue(value: CellValue): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Uint8Array) {
    return `<BLOB ${value.byteLength} bytes>`;
  }
  return String(value);
}

function padCell(value: string, width: number): string {
  const truncated = truncateToWidth(
    sanitizeCell(value),
    Math.max(width, MIN_COLUMN_WIDTH),
  );
  const visible = cellWidth(truncated);
  if (visible >= width) {
    return truncated;
  }
  return truncated + ' '.repeat(width - visible);
}

/** True when the horizontal layout can fit at the per-column floor width. */
function tableFitsAtMinimum(columnCount: number): boolean {
  return (
    MIN_COLUMN_WIDTH * columnCount +
      COLUMN_SEPARATOR_WIDTH * columnCount +
      TABLE_FRAME_WIDTH <=
    MAX_RENDER_WIDTH
  );
}

/** Expanded (psql `\x`-like) fallback for tables too wide to render sideways. */
function buildVerticalBlocks(headers: string[], rows: CellValue[][]): string {
  if (rows.length === 0) {
    return '(no rows)';
  }
  let nameWidth = MIN_COLUMN_WIDTH;
  for (const header of headers) {
    nameWidth = Math.max(nameWidth, cellWidth(sanitizeCell(header)));
  }
  nameWidth = Math.min(MAX_COLUMN_WIDTH, nameWidth);
  return rows
    .map((row, index) => {
      const block = [`── Row ${index + 1} ──`];
      for (const [columnIndex, header] of headers.entries()) {
        const name = padCell(header, nameWidth);
        const value = sanitizeCell(stringifyValue(row[columnIndex]));
        block.push(truncateToWidth(`${name}: ${value}`, MAX_RENDER_WIDTH));
      }
      return block.join('\n');
    })
    .join('\n\n');
}

function buildAsciiTable(headers: string[], rows: CellValue[][]): string {
  if (headers.length === 0) {
    return rows.length === 0
      ? '(no rows)'
      : '(rows returned without named columns)';
  }
  if (!tableFitsAtMinimum(headers.length)) {
    return buildVerticalBlocks(headers, rows);
  }

  const widths = headers.map((header) =>
    Math.max(
      MIN_COLUMN_WIDTH,
      Math.min(MAX_COLUMN_WIDTH, cellWidth(sanitizeCell(header))),
    ),
  );
  for (const row of rows) {
    for (let index = 0; index < headers.length; index++) {
      const width = cellWidth(sanitizeCell(stringifyValue(row[index])));
      widths[index] = Math.max(
        widths[index] ?? MIN_COLUMN_WIDTH,
        Math.min(MAX_COLUMN_WIDTH, width),
      );
    }
  }

  const overhead = headers.length * COLUMN_SEPARATOR_WIDTH + TABLE_FRAME_WIDTH;
  let totalWidth = widths.reduce((sum, width) => sum + width, 0) + overhead;
  while (totalWidth > MAX_RENDER_WIDTH) {
    let widestIndex = -1;
    let widestWidth = MIN_COLUMN_WIDTH;
    for (const [index, width] of widths.entries()) {
      if (width > widestWidth) {
        widestIndex = index;
        widestWidth = width;
      }
    }
    if (widestIndex === -1) {
      break;
    }
    widths[widestIndex] = Math.max(
      MIN_COLUMN_WIDTH,
      (widths[widestIndex] ?? MIN_COLUMN_WIDTH) - 1,
    );
    totalWidth = widths.reduce((sum, width) => sum + width, 0) + overhead;
  }

  const header = `| ${headers.map((h, i) => padCell(h, widths[i] ?? MIN_COLUMN_WIDTH)).join(' | ')} |`;
  const divider = `| ${widths.map((width) => '-'.repeat(Math.max(width, MIN_COLUMN_WIDTH))).join(' | ')} |`;
  const lines = [header, divider];

  if (rows.length === 0) {
    lines.push('(no rows)');
    return lines.join('\n');
  }

  for (const row of rows) {
    const cells = headers.map((_, i) =>
      padCell(stringifyValue(row[i]), widths[i] ?? MIN_COLUMN_WIDTH),
    );
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

/**
 * Renders an ASCII table. Values are stringified defensively: `bigint` columns
 * become their decimal string and never throw.
 */
export function renderSqliteTable(
  headers: string[],
  rows: Array<Array<string | number | null | bigint>>,
): string {
  return buildAsciiTable(headers, rows);
}

const FORBIDDEN_WHERE_KEYWORDS = new Set([
  'limit',
  'offset',
  'union',
  'intersect',
  'except',
  'attach',
  'detach',
  'pragma',
]);

const COMMENT_OR_TERMINATOR_ERROR =
  "SQLite 'where' clause must not contain comments or statement terminators; use '?q=SELECT ...' for raw SQL";
const FORBIDDEN_KEYWORD_ERROR =
  "SQLite 'where' clause must not contain LIMIT/OFFSET/UNION/INTERSECT/EXCEPT/ATTACH/DETACH/PRAGMA; use '?q=SELECT ...' for raw SQL";

/**
 * Scans a `where=` clause character-by-character, tracking quoted literals, and
 * rejects comments, statement terminators, and pagination/attach/pragma
 * keywords so the structured path cannot escape its bound `LIMIT ? OFFSET ?`.
 */
function findWhereClauseViolation(sql: string): string | null {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let tokenStart = -1;
  let keywordViolation: string | null = null;

  const flushToken = (end: number): void => {
    if (tokenStart < 0 || keywordViolation) {
      tokenStart = -1;
      return;
    }
    const token = sql.slice(tokenStart, end).toLowerCase();
    tokenStart = -1;
    if (FORBIDDEN_WHERE_KEYWORDS.has(token)) {
      keywordViolation = FORBIDDEN_KEYWORD_ERROR;
    }
  };

  for (let index = 0; index <= sql.length; index++) {
    const char = index < sql.length ? sql[index] : undefined;
    const next = index + 1 < sql.length ? sql[index + 1] : undefined;

    if (inSingleQuote) {
      if (char === "'" && next === "'") {
        index += 1;
        continue;
      }
      if (char === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (inDoubleQuote) {
      if (char === '"' && next === '"') {
        index += 1;
        continue;
      }
      if (char === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    const isIdent = char !== undefined && /[A-Za-z0-9_]/.test(char);
    if (isIdent) {
      if (tokenStart < 0) {
        tokenStart = index;
      }
      continue;
    }

    flushToken(index);

    if (char === undefined) {
      break;
    }
    if (char === "'") {
      inSingleQuote = true;
      continue;
    }
    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (char === ';') {
      return COMMENT_OR_TERMINATOR_ERROR;
    }
    if (
      (char === '-' && next === '-') ||
      (char === '/' && next === '*') ||
      (char === '*' && next === '/')
    ) {
      return COMMENT_OR_TERMINATOR_ERROR;
    }
  }

  return keywordViolation;
}

/** Throws when a `where=` body could escape the structured, paginated path. */
export function validateWhereClause(where: string): void {
  const trimmed = where.trim();
  if (!trimmed) {
    return;
  }
  const violation = findWhereClauseViolation(trimmed);
  if (violation) {
    throw new Error(violation);
  }
}

function parseLimit(value: string | null, fallback: number): number {
  if (value === null || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`SQLite limit must be a positive integer; got '${value}'`);
  }
  return Math.min(parsed, MAX_QUERY_LIMIT);
}

function parseOffset(value: string | null): number {
  if (value === null || value.trim().length === 0) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `SQLite offset must be a non-negative integer; got '${value}'`,
    );
  }
  return parsed;
}

/** Leading keywords that cannot mutate a database. */
const READ_ONLY_LEADING_KEYWORDS = new Set([
  'select',
  'with',
  'values',
  'explain',
]);

/**
 * Rejects anything that is not a single read-only statement. This is a
 * pre-filter only — the authoritative guard is the `query_only` pragma plus
 * `StatementSync.readonly` checked on the prepared statement itself.
 */
function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error("SQLite query parameter 'q' cannot be empty");
  }
  // A single `;` is only tolerated as a trailing terminator; anything else is a
  // multi-statement payload (e.g. a stacked DROP behind a SELECT).
  const body = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
  if (body.includes(';')) {
    throw new Error('SQLite raw queries must contain exactly one statement');
  }
  const leading = /^([A-Za-z]+)/.exec(body)?.[1]?.toLowerCase();
  if (!leading || !READ_ONLY_LEADING_KEYWORDS.has(leading)) {
    throw new Error(
      `SQLite raw queries must be read-only (SELECT/WITH/VALUES/EXPLAIN); got '${trimmed.slice(0, 40)}'`,
    );
  }
}

/**
 * Parses a `path/to/db.sqlite[:table[:key]][?opts]` target into a file path
 * plus selector. Returns `null` when the target is not SQLite-shaped.
 */
export function parseSqliteSelector(
  raw: string,
): { filePath: string; selector: SqliteSelector } | null {
  const trimmed = raw.trim();
  if (!looksLikeSqlitePath(trimmed)) {
    return null;
  }

  const extensionMatch = /\.(?:sqlite3?|db3?)(?=(?::|\?|$))/i.exec(trimmed);
  if (!extensionMatch) {
    return null;
  }
  const extensionEnd = extensionMatch.index + extensionMatch[0].length;
  const filePath = trimmed.slice(0, extensionEnd);
  const { subPath, queryString } = splitSqliteRemainder(
    trimmed.slice(extensionEnd),
  );
  const params = new URLSearchParams(queryString);
  const rawQuery = params.get('q');

  if (rawQuery !== null) {
    const otherKeys = [...params.keys()].filter((key) => key !== 'q');
    if (subPath || otherKeys.length > 0) {
      throw new Error(
        'SQLite raw queries cannot be combined with table selectors or pagination',
      );
    }
    if (!rawQuery.trim()) {
      throw new Error("SQLite query parameter 'q' cannot be empty");
    }
    assertReadOnlySql(rawQuery);
    return { filePath, selector: { kind: 'raw', sql: rawQuery } };
  }

  if (!subPath) {
    if (params.size > 0) {
      const keys = [...new Set(params.keys())];
      if (keys.length === 1 && keys[0] === 'raw') {
        return { filePath, selector: { kind: 'raw' } };
      }
      throw new Error(
        'SQLite query parameters require a table selector or q=SELECT...',
      );
    }
    return { filePath, selector: { kind: 'list' } };
  }

  const separatorIndex = subPath.indexOf(':');
  const table =
    separatorIndex === -1 ? subPath : subPath.slice(0, separatorIndex);
  const key =
    separatorIndex === -1 ? undefined : subPath.slice(separatorIndex + 1);
  if (!table) {
    throw new Error('SQLite selectors must include a table name');
  }

  if (key !== undefined && key.length > 0) {
    if (params.size > 0) {
      throw new Error(
        'SQLite row lookups cannot be combined with query parameters',
      );
    }
    return { filePath, selector: { kind: 'row', table, key } };
  }

  const knownKeys = new Set(['limit', 'offset', 'order', 'where', 'raw']);
  for (const keyName of params.keys()) {
    if (!knownKeys.has(keyName)) {
      throw new Error(`Unsupported SQLite query parameter '${keyName}'`);
    }
  }

  const rawFlag = params.get('raw');
  if (rawFlag !== null) {
    if (!['true', '1', ''].includes(rawFlag.toLowerCase())) {
      throw new Error(
        `SQLite 'raw' parameter must be 'true' or absent; got '${rawFlag}'`,
      );
    }
    if (params.size > 1) {
      throw new Error(
        "SQLite 'raw' cannot be combined with other query parameters",
      );
    }
    return { filePath, selector: { kind: 'raw', table } };
  }

  const whereParam = params.get('where');
  if (whereParam !== null) {
    validateWhereClause(whereParam);
  }
  const order = params.get('order')?.trim() || undefined;
  const hasQueryParams =
    params.has('limit') ||
    params.has('offset') ||
    order !== undefined ||
    whereParam !== null;
  if (hasQueryParams) {
    return {
      filePath,
      selector: {
        kind: 'query',
        table,
        limit: parseLimit(params.get('limit'), DEFAULT_QUERY_LIMIT),
        offset: parseOffset(params.get('offset')),
        order,
        where: whereParam === null ? undefined : whereParam.trim(),
      },
    };
  }

  return {
    filePath,
    selector: { kind: 'schema', table, limit: DEFAULT_SCHEMA_SAMPLE_LIMIT },
  };
}

/* ------------------------------------------------------------------ */
/* Database access                                                      */
/* ------------------------------------------------------------------ */

interface ColumnInfo {
  name: string;
}

interface StatementLike {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  columns(): ColumnInfo[];
  readonly sourceSQL: string;
  /** Present on `StatementSync` since Node 22.15. */
  readonly?: boolean;
}

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}

function openDatabase(filePath: string): DatabaseLike {
  let db: DatabaseLike | undefined;
  try {
    // `readOnly` plus `PRAGMA query_only` below are two independent engine-level
    // guarantees: a mutating statement cannot be prepared-and-stepped into an
    // actual write from any selector form.
    db = new DatabaseSync(filePath, { readOnly: true });
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA query_only = 1');
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Ignore close failures while unwinding the open error.
    }
    throw new Error(
      `Failed to open SQLite database '${filePath}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!db) {
    throw new Error(`Failed to open SQLite database '${filePath}'`);
  }
  return db;
}

/**
 * Verifies a prepared statement cannot mutate before it is stepped. Node's
 * `StatementSync` exposes a `readonly` flag on newer releases; when present it
 * is authoritative, and the `query_only` pragma backstops every older runtime.
 */
function assertStatementReadOnly(statement: StatementLike, sql: string): void {
  if (typeof statement.readonly === 'boolean' && !statement.readonly) {
    throw new Error(
      `SQLite statement is not read-only and was refused: '${sql.slice(0, 60)}'`,
    );
  }
  if (statement.sourceSQL !== sql) {
    throw new Error('SQLite statement text did not round-trip and was refused');
  }
}

/** Runs a query and returns headers plus cell rows. */
function runQuery(
  db: DatabaseLike,
  sql: string,
  params: unknown[],
  limit: number,
): { headers: string[]; rows: CellValue[][]; truncated: boolean } {
  const statement = db.prepare(sql);
  assertStatementReadOnly(statement, sql);
  const records = statement.all(...params);
  const headers =
    records.length > 0
      ? Object.keys(records[0])
      : statement.columns().map((c) => c.name);
  const rows = records
    .slice(0, limit)
    .map((record) => headers.map((header) => toCellValue(record[header])));
  return { headers, rows, truncated: records.length > limit };
}

/**
 * Narrow one raw driver value to a cell. Values the engine can return are kept
 * as-is; anything else is stringified exactly as {@link stringifyValue} would.
 */
function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return value;
  if (value instanceof Uint8Array) return value;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return String(value);
}

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function getMasterRow(
  db: DatabaseLike,
  table: string,
): Record<string, unknown> {
  const row = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name = ?",
    )
    .get(table);
  if (!row) {
    throw new Error(`SQLite table '${table}' not found`);
  }
  return row;
}

function getTableInfoRows(db: DatabaseLike, table: string): TableInfoRow[] {
  getMasterRow(db, table);
  return db
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map(toTableInfoRow);
}

/** Project one `PRAGMA table_info` record onto the columns callers read. */
function toTableInfoRow(record: Record<string, unknown>): TableInfoRow {
  return {
    name: String(record['name'] ?? ''),
    type: String(record['type'] ?? ''),
    notnull: Number(record['notnull'] ?? 0),
    dflt_value: record['dflt_value'],
    pk: Number(record['pk'] ?? 0),
  };
}

function coerceIntegerKey(key: string, label: string): number | bigint {
  const trimmed = key.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`${label} must be an integer; got '${key}'`);
  }
  const asNumber = Number.parseInt(trimmed, 10);
  if (Number.isSafeInteger(asNumber)) {
    return asNumber;
  }
  return BigInt(trimmed);
}

function coerceLookupValue(key: string, type: string): unknown {
  const normalized = type.trim().toUpperCase();
  if (normalized.includes('INT')) {
    return coerceIntegerKey(key, `Primary key '${key}'`);
  }
  if (
    normalized.includes('REAL') ||
    normalized.includes('FLOA') ||
    normalized.includes('DOUB')
  ) {
    const parsed = Number(key);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return key;
}

function resolveOrderClause(
  order: string | undefined,
  columns: string[],
): string {
  if (!order) {
    return '';
  }
  const trimmed = order.trim();
  if (!trimmed) {
    return '';
  }
  const separatorIndex = trimmed.lastIndexOf(':');
  const column =
    separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
  const direction =
    separatorIndex === -1
      ? 'asc'
      : trimmed
          .slice(separatorIndex + 1)
          .trim()
          .toLowerCase();
  if (!columns.includes(column)) {
    throw new Error(
      `SQLite order column '${column}' not found in table schema`,
    );
  }
  if (direction !== 'asc' && direction !== 'desc') {
    throw new Error(
      `SQLite order direction must be 'asc' or 'desc'; got '${direction}'`,
    );
  }
  return ` ORDER BY ${quoteIdentifier(column)} ${direction.toUpperCase()}`;
}

interface RowCount {
  kind: 'exact' | 'estimate' | 'atLeast';
  rows: number;
}

function loadRowEstimates(db: DatabaseLike): Map<string, number> {
  const estimates = new Map<string, number>();
  const hasStat1 = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'",
    )
    .get();
  if (!hasStat1) {
    return estimates;
  }
  for (const row of db.prepare('SELECT tbl, stat FROM sqlite_stat1').all()) {
    const tbl = row['tbl'];
    const stat = row['stat'];
    if (typeof tbl !== 'string' || typeof stat !== 'string') {
      continue;
    }
    const rows = Number.parseInt(stat, 10);
    if (!Number.isFinite(rows)) {
      continue;
    }
    const previous = estimates.get(tbl);
    if (previous === undefined || rows > previous) {
      estimates.set(tbl, rows);
    }
  }
  return estimates;
}

function probeRowCount(db: DatabaseLike, table: string, cap: number): RowCount {
  const sql = `SELECT COUNT(*) AS count FROM (SELECT 1 FROM ${quoteIdentifier(table)} LIMIT ${cap + 1})`;
  const row = db.prepare(sql).get();
  const counted = Number(row?.['count'] ?? 0);
  return counted > cap
    ? { kind: 'atLeast', rows: cap }
    : { kind: 'exact', rows: counted };
}

function formatRowCount(count: RowCount): string {
  switch (count.kind) {
    case 'exact':
      return `${count.rows} rows`;
    case 'estimate':
      return `~${count.rows} rows`;
    case 'atLeast':
      return `${count.rows}+ rows`;
    default:
      return `${count.rows} rows`;
  }
}

function renderTableList(db: DatabaseLike): string {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE",
    )
    .all();
  if (names.length === 0) {
    return '(no tables)';
  }
  const capped = names.slice(0, MAX_LISTED_TABLES);
  const estimates = loadRowEstimates(db);
  const lines = capped.map((row) => {
    const name = String(row['name']);
    const estimate = estimates.get(name);
    const count: RowCount =
      estimate !== undefined && estimate > ROW_COUNT_PROBE_CAP
        ? { kind: 'estimate', rows: estimate }
        : probeRowCount(db, name, ROW_COUNT_PROBE_CAP);
    return truncateToWidth(
      sanitizeCell(`${name} (${formatRowCount(count)})`),
      MAX_RENDER_WIDTH,
    );
  });
  if (names.length > MAX_LISTED_TABLES) {
    lines.push(
      `[${names.length - MAX_LISTED_TABLES} more tables not shown; cap is ${MAX_LISTED_TABLES}]`,
    );
  }
  return lines.join('\n');
}

function renderSchema(
  db: DatabaseLike,
  table: string,
  sampleLimit: number,
): string {
  const master = getMasterRow(db, table);
  const createSql = master['sql'];
  if (typeof createSql !== 'string') {
    throw new Error(`SQLite schema for table '${table}' is unavailable`);
  }
  const sample = runQuery(
    db,
    `SELECT * FROM ${quoteIdentifier(table)} LIMIT ?`,
    [sampleLimit],
    sampleLimit,
  );
  const schemaLines = sanitizeCell(createSql)
    .split('\n')
    .map((line) => truncateToWidth(line, MAX_RENDER_WIDTH))
    .join('\n');
  return [
    schemaLines,
    '',
    'Sample rows:',
    buildAsciiTable(sample.headers, sample.rows),
  ].join('\n');
}

function renderRow(db: DatabaseLike, table: string, key: string): string {
  const infoRows = getTableInfoRows(db, table);
  const pkColumns = infoRows
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk);

  let sql: string;
  let param: unknown;
  if (pkColumns.length === 1) {
    const pk = pkColumns[0];
    param = coerceLookupValue(key, pk.type);
    sql = `SELECT * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(pk.name)} = ? LIMIT 1`;
  } else if (pkColumns.length > 1) {
    throw new Error(
      `SQLite table '${table}' has a composite primary key (${pkColumns.map((c) => c.name).join(', ')}); use '?q=SELECT ...' instead`,
    );
  } else {
    param = coerceIntegerKey(key, `Rowid '${key}'`);
    sql = `SELECT * FROM ${quoteIdentifier(table)} WHERE rowid = ? LIMIT 1`;
  }

  const result = runQuery(db, sql, [param], 1);
  if (result.rows.length === 0) {
    return `No row matching ${table} key '${key}'`;
  }
  const row = result.rows[0];
  const lines = result.headers.map((header, index) =>
    truncateToWidth(
      sanitizeCell(`${header}: ${stringifyValue(row[index])}`),
      MAX_RENDER_WIDTH,
    ),
  );
  return lines.join('\n');
}

function renderQuery(
  db: DatabaseLike,
  table: string,
  selector: SqliteSelector,
): string {
  const limit = Math.min(
    selector.limit ?? DEFAULT_QUERY_LIMIT,
    MAX_QUERY_LIMIT,
  );
  const offset = selector.offset ?? 0;
  const columns = getTableInfoRows(db, table).map((column) => column.name);
  const orderClause = resolveOrderClause(selector.order, columns);

  const where = selector.where;
  if (where) {
    validateWhereClause(where);
  }

  const quoted = quoteIdentifier(table);
  const totalCount = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${quoted}${where ? ` WHERE ${where}` : ''}`,
      )
      .get()?.['count'] ?? 0,
  );
  const result = runQuery(
    db,
    `SELECT * FROM ${quoted}${where ? ` WHERE ${where}` : ''}${orderClause} LIMIT ? OFFSET ?`,
    [limit, offset],
    limit,
  );

  const parts = [buildAsciiTable(result.headers, result.rows)];
  const shown = Math.min(totalCount, offset + result.rows.length);
  if (shown < totalCount) {
    const remaining = totalCount - shown;
    const nextOffset = offset + result.rows.length;
    parts.push(
      truncateToWidth(
        `[${remaining} more rows; append :${table}?limit=${limit}&offset=${nextOffset} to the database path to continue]`,
        MAX_RENDER_WIDTH,
      ),
    );
  }
  return parts.join('\n');
}

function renderRawQuery(db: DatabaseLike, sql: string): string {
  assertReadOnlySql(sql);
  const result = runQuery(db, sql, [], SQLITE_MAX_ROWS);
  const parts = [buildAsciiTable(result.headers, result.rows)];
  if (result.truncated) {
    parts.push(
      `[truncated to ${SQLITE_MAX_ROWS} rows; add a LIMIT clause for exact results]`,
    );
  }
  return parts.join('\n');
}

function renderRawMaster(db: DatabaseLike): string {
  const result = runQuery(
    db,
    'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
    [],
    SQLITE_MAX_ROWS,
  );
  return buildAsciiTable(result.headers, result.rows);
}

/**
 * Opens the database, runs the selector, and returns the rendered text. The
 * connection is always closed and `node:sqlite` is only loaded on first use.
 */
export function readSqlite(target: string, selector: SqliteSelector): string {
  const parsed = parseSqliteSelector(target);
  if (!parsed) {
    throw new Error(`Not a SQLite database path: '${target}'`);
  }

  const db = openDatabase(parsed.filePath);
  try {
    if (!isSqliteFile(parsed.filePath)) {
      throw new Error(`Not a SQLite database file: '${parsed.filePath}'`);
    }
    return renderSelector(db, parsed.filePath, selector);
  } finally {
    try {
      db.close();
    } catch {
      // A close failure must not mask the caller's result.
    }
  }
}

function renderSelector(
  db: DatabaseLike,
  filePath: string,
  selector: SqliteSelector,
): string {
  switch (selector.kind) {
    case 'list':
      return renderTableList(db);
    case 'schema':
      return renderSchema(
        db,
        requireTable(selector),
        selector.limit ?? DEFAULT_SCHEMA_SAMPLE_LIMIT,
      );
    case 'row':
      return renderRow(db, requireTable(selector), selector.key ?? '');
    case 'query':
      return renderQuery(db, requireTable(selector), selector);
    case 'raw':
      if (selector.sql !== undefined) {
        return renderRawQuery(db, selector.sql);
      }
      if (selector.table !== undefined) {
        return renderRawMaster(db);
      }
      return renderTableList(db);
    default: {
      const exhaustive: never = selector.kind;
      throw new Error(
        `Unsupported SQLite selector '${String(exhaustive)}' in '${filePath}'`,
      );
    }
  }
}

function requireTable(selector: SqliteSelector): string {
  if (!selector.table) {
    throw new Error('SQLite selector requires a table name');
  }
  return selector.table;
}
