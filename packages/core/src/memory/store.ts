/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { redactText } from './redact.js';
import type {
  MemoryBackend,
  MemoryBackendId,
  MemoryEditOp,
  MemoryEditPatch,
  MemoryEditStatus,
  MemoryOperationContext,
  MemoryRecallOptions,
  MemoryRecord,
  MemoryRetainItem,
  MemoryScope,
  MemorySearchHit,
  MemoryStatus,
  MemoryStoreKind,
} from './types.js';

/**
 * A local, file-backed memory bank.
 *
 * omp ships `mnemopi` for this, but that engine is `bun:sqlite` plus a Rust
 * N-API module plus a fork of omp's own LLM client — none of which exist here.
 * This is a fresh, small Node-native store instead: one SQLite file, a
 * tokenised text column, and lexical scoring with a light stemmer so that
 * `backups` finds `backup`.
 *
 * Records are partitioned by scope, and a project partition is keyed by the
 * absolute `cwd`, so two checkouts of the same repo never see each other's
 * memories.
 */

/** Default cap on rows returned by one `recall`. */
export const DEFAULT_RECALL_LIMIT = 20;

/** The only store kind `retain` writes; `lesson` comes from `learn`. */
const FACT_STORE_KIND: MemoryStoreKind = 'fact';

/** Rows newer than this many days get a recency bonus, decaying to zero. */
const RECENCY_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

interface MemoryRow {
  id: string;
  content: string;
  context: string | null;
  scope: string;
  store: string;
  importance: number;
  source: string | null;
  session_id: string | null;
  cwd: string | null;
  created_at: string;
  invalidated_at: string | null;
  derived_from: string | null;
}

/**
 * SQLite column definitions.
 *
 * `derived_from` is what makes a `fact` a projection: a fact carrying it was
 * extracted from other rows, so an in-place edit would be silently reverted by
 * the next consolidation and must be refused instead.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id             TEXT PRIMARY KEY,
  content        TEXT NOT NULL,
  context        TEXT,
  scope          TEXT NOT NULL,
  store          TEXT NOT NULL,
  importance     REAL NOT NULL,
  source         TEXT,
  session_id     TEXT,
  cwd            TEXT,
  created_at     TEXT NOT NULL,
  invalidated_at TEXT,
  derived_from   TEXT
);
CREATE INDEX IF NOT EXISTS memories_by_scope ON memories (scope, cwd);
CREATE TABLE IF NOT EXISTS memory_tokens (
  term  TEXT NOT NULL,
  rowid TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_tokens_by_term ON memory_tokens (term);
`;

function isMemoryRow(value: unknown): value is MemoryRow {
  if (typeof value !== 'object' || value === null) return false;
  return 'id' in value && 'content' in value && 'created_at' in value;
}

/**
 * Reduce a word to a crude stem so recall matches on meaning rather than on
 * inflection: `backups`/`backup`, `caching`/`cache`, `running`/`run`.
 *
 * This is deliberately morphology, not a language model — it exists so a
 * remembered sentence finds the question phrased slightly differently.
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;
  for (const suffix of ['ing', 'edly', 'ies', 'ied', 'es', 'ed', 's', 'ly']) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, w.length - suffix.length);
      if (suffix === 'ies' || suffix === 'ied') w += 'y';
      break;
    }
  }
  // English doubles a final consonant before -ing/-ed, so `running` stems to
  // `runn` unless the doubling is undone.
  const last = w[w.length - 1];
  if (
    w.length >= 4 &&
    last !== undefined &&
    last === w[w.length - 2] &&
    'bdgklmnprt'.includes(last)
  ) {
    w = w.slice(0, -1);
  }
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/**
 * Words that carry no information about which memory is wanted.
 *
 * Rarity alone cannot filter these out: in a one-memory bank every term is
 * "common", so idf ranking degenerates. A stopword list is what makes "where
 * are the migrations" find the migrations and not the memory that merely
 * contains "the".
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'did',
  'do',
  'doe',
  'for',
  'from',
  'get',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'up',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/** Tokenise into stems, dropping punctuation, stopwords and tiny words. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 2) continue;
    if (STOP_WORDS.has(raw)) continue;
    const stemmed = stem(raw);
    if (stemmed.length >= 2 && !STOP_WORDS.has(stemmed)) out.push(stemmed);
  }
  return out;
}

export interface LocalMemoryOptions {
  /** Directory the bank lives in. The caller owns this path. */
  dir: string;
  /** File name inside `dir`. */
  fileName?: string;
  /** Environment values treated as secret on write. */
  envValues?: readonly string[];
}

export class LocalMemoryBackend implements MemoryBackend {
  readonly id: MemoryBackendId = 'local';

  readonly #dir: string;
  readonly #fileName: string;
  readonly #envValues: readonly string[];
  #db: DatabaseSync | undefined;

  constructor(options: LocalMemoryOptions) {
    this.#dir = options.dir;
    this.#fileName = options.fileName ?? 'memories.db';
    this.#envValues = options.envValues ?? [];
  }

  /** Absolute path of the SQLite file, whether or not it exists yet. */
  databasePath(): string {
    return path.join(this.#dir, this.#fileName);
  }

  async start(_ctx: MemoryOperationContext): Promise<void> {
    if (this.#db !== undefined) return;
    fs.mkdirSync(this.#dir, { recursive: true });
    const db = new DatabaseSync(this.databasePath());
    try {
      // A stale or corrupt bank must not brick the session; move it aside and
      // start clean rather than throwing out of `start()`.
      db.exec(SCHEMA);
    } catch {
      db.close();
      this.#quarantine();
      const retry = new DatabaseSync(this.databasePath());
      retry.exec(SCHEMA);
      this.#db = retry;
      return;
    }
    this.#db = db;
  }

  developerInstructions(): string {
    return [
      'A local memory bank is available.',
      '',
      '- `retain` stores a durable fact about this codebase so future sessions start with it.',
      '- `recall` searches what you have retained.',
      '- `reflect` answers a question from the bank.',
      '- `memory_edit` corrects, forgets or invalidates a stored memory by id.',
      '',
      'Store what will still be true next week, and what the code does not say.',
      'Do not store secrets; values that look like credentials are redacted on write.',
    ].join('\n');
  }

  async status(): Promise<MemoryStatus> {
    const db = this.#require();
    const row = db
      .prepare(
        'SELECT COUNT(*) AS n FROM memories WHERE invalidated_at IS NULL',
      )
      .get();
    const count = isCountRow(row) ? row.n : 0;
    return { available: true, count, backend: this.id };
  }

  async retain(
    items: MemoryRetainItem[],
    ctx: MemoryOperationContext,
  ): Promise<{ stored: number }> {
    if (items.length === 0) return { stored: 0 };
    const db = this.#require();
    const insert = db.prepare(
      `INSERT INTO memories
         (id, content, context, scope, store, importance, source, session_id, cwd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertToken = db.prepare(
      'INSERT INTO memory_tokens (term, rowid) VALUES (?, ?)',
    );
    const now = new Date().toISOString();
    let stored = 0;
    for (const item of items) {
      const content = redactText(item.content, { envValues: this.#envValues });
      if (content.trim() === '') continue;
      const context = item.context
        ? redactText(item.context, { envValues: this.#envValues })
        : null;
      const id = crypto.randomUUID();
      const scope: MemoryScope = item.scope ?? 'project';
      insert.run(
        id,
        content,
        context,
        scope,
        FACT_STORE_KIND,
        0.75,
        'retain',
        ctx.sessionId ?? null,
        scope === 'project' ? ctx.cwd : null,
        now,
      );
      for (const term of new Set(tokenize(`${content} ${context ?? ''}`))) {
        insertToken.run(term, id);
      }
      stored++;
    }
    return { stored };
  }

  async recall(
    query: string,
    opts: MemoryRecallOptions,
    signal?: AbortSignal,
  ): Promise<MemorySearchHit[]> {
    const db = this.#require();
    const limit = opts.limit ?? DEFAULT_RECALL_LIMIT;
    const scopes: MemoryScope[] = opts.includeGlobal
      ? ['project', 'global']
      : ['project'];
    const terms = [...new Set(tokenize(query))];

    // No query terms means "what matters most", not "nothing": an empty recall
    // is the single most useless answer a memory tool can give.
    if (terms.length === 0) {
      return this.#topByImportance(db, scopes, opts.cwd, limit);
    }

    const placeholders = terms.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memory_tokens t ON t.rowid = m.id
         WHERE t.term IN (${placeholders})
           AND m.invalidated_at IS NULL
           AND m.scope IN (${scopes.map(() => '?').join(',')})
           AND (m.scope = 'global' OR m.cwd = ?)
         GROUP BY m.id`,
      )
      .all(...terms, ...scopes, opts.cwd);

    // A query word that appears in every memory ("the", "where") says nothing
    // about which memory is wanted, so terms are weighted by how rare they
    // are. Without this, a fact that merely shares a stopword outranks the
    // fact the question was actually about.
    const documentFrequency = new Map<string, number>();
    for (const term of terms) {
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT t.rowid) AS n FROM memory_tokens t
           JOIN memories m ON m.id = t.rowid
           WHERE t.term = ?
             AND m.invalidated_at IS NULL
             AND m.scope IN (${scopes.map(() => '?').join(',')})
             AND (m.scope = 'global' OR m.cwd = ?)`,
        )
        .get(term, ...scopes, opts.cwd);
      documentFrequency.set(term, isCountRow(row) ? row.n : 0);
    }
    // Rarity is judged against the whole visible bank, not against the
    // candidates: a term that appears in every candidate row is still a rare
    // term if the bank holds a hundred other memories.
    const totalRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories
         WHERE invalidated_at IS NULL
           AND scope IN (${scopes.map(() => '?').join(',')})
           AND (scope = 'global' OR cwd = ?)`,
      )
      .get(...scopes, opts.cwd);
    const totalDocs = isCountRow(totalRow) ? Math.max(1, totalRow.n) : 1;
    const weightOf = (term: string) => {
      const df = documentFrequency.get(term) ?? 0;
      return Math.log(1 + totalDocs / (1 + df));
    };
    const queryWeight = terms.reduce((sum, term) => sum + weightOf(term), 0);

    // A word that appears in most memories carries no information about which
    // memory is wanted. When the whole query is made of such words, answering
    // "here are some memories" is worse than saying the bank has nothing
    // relevant, so fall through to importance order instead.
    const selective = terms.filter((term) => {
      const df = documentFrequency.get(term) ?? 0;
      return df < totalDocs;
    });
    if (selective.length === 0) {
      return this.#topByImportance(db, scopes, opts.cwd, limit);
    }
    const selectiveSet = new Set<string>(selective);

    const now = Date.now();
    const hits: MemorySearchHit[] = [];
    for (const candidate of rows) {
      if (signal?.aborted) break;
      if (!isMemoryRow(candidate)) continue;
      const termsHit = tokenize(
        `${candidate.content} ${candidate.context ?? ''}`,
      );
      // A row qualifies only if it matched a term that is actually selective.
      // Sharing a word with every memory in the bank is not a match.
      const matched = terms.filter((term) => termsHit.includes(term));
      if (!matched.some((term) => selectiveSet.has(term))) continue;
      const matchedWeight = matched.reduce(
        (sum, term) => sum + weightOf(term),
        0,
      );
      const coverage = queryWeight === 0 ? 0 : matchedWeight / queryWeight;
      if (coverage === 0) continue;
      const recency = Math.max(
        0,
        1 -
          (now - Date.parse(candidate.created_at)) /
            (RECENCY_WINDOW_DAYS * DAY_MS),
      );
      const score = coverage * 0.7 + candidate.importance * 0.2 + recency * 0.1;
      hits.push({ ...toRecord(candidate), score });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, limit);
  }

  async edit(
    op: MemoryEditOp,
    id: string,
    patch: MemoryEditPatch | undefined,
    ctx: { cwd: string },
  ): Promise<MemoryEditStatus> {
    const db = this.#require();
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!isMemoryRow(row)) return 'not_found';
    if (row.scope === 'project' && row.cwd !== null && row.cwd !== ctx.cwd) {
      return 'not_found';
    }
    if (op === 'forget') {
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      db.prepare('DELETE FROM memory_tokens WHERE rowid = ?').run(id);
      return 'deleted';
    }
    if (op === 'invalidate') {
      db.prepare('UPDATE memories SET invalidated_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        id,
      );
      return 'invalidated';
    }
    // A derived fact is regenerated from its sources; an in-place write would
    // be reverted on the next consolidation, so refuse rather than lie.
    if (row.store === 'fact' && row.derived_from !== null) {
      return 'not_editable';
    }
    const content =
      patch?.content === undefined
        ? null
        : redactText(patch.content, { envValues: this.#envValues });
    const importance =
      patch?.importance === undefined
        ? null
        : Math.min(1, Math.max(0, patch.importance));
    if (content !== null && content.trim() === '') {
      // An update that erases the content is a forget, not an empty memory.
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      db.prepare('DELETE FROM memory_tokens WHERE rowid = ?').run(id);
      return 'deleted';
    }
    if (content === null && importance === null) return 'not_found';
    db.prepare(
      'UPDATE memories SET content = COALESCE(?, content), importance = COALESCE(?, importance) WHERE id = ?',
    ).run(content, importance, id);
    if (content !== null) {
      db.prepare('DELETE FROM memory_tokens WHERE rowid = ?').run(id);
      const insertToken = db.prepare(
        'INSERT INTO memory_tokens (term, rowid) VALUES (?, ?)',
      );
      for (const term of new Set(tokenize(content))) insertToken.run(term, id);
    }
    return 'updated';
  }

  async clear(ctx: { cwd: string }): Promise<void> {
    const db = this.#require();
    const rows = db
      .prepare("SELECT id FROM memories WHERE scope = 'project' AND cwd = ?")
      .all(ctx.cwd);
    const del = db.prepare('DELETE FROM memories WHERE id = ?');
    const delTokens = db.prepare('DELETE FROM memory_tokens WHERE rowid = ?');
    for (const row of rows) {
      if (!isMemoryRow(row)) continue;
      del.run(row.id);
      delTokens.run(row.id);
    }
  }

  async dispose(): Promise<void> {
    if (this.#db === undefined) return;
    this.#db.close();
    this.#db = undefined;
  }

  #require(): DatabaseSync {
    if (this.#db === undefined) {
      throw new Error(
        'The memory bank is not open. Call start() before using it.',
      );
    }
    return this.#db;
  }

  #topByImportance(
    db: DatabaseSync,
    scopes: MemoryScope[],
    cwd: string,
    limit: number,
  ): MemorySearchHit[] {
    const rows = db
      .prepare(
        `SELECT * FROM memories
         WHERE invalidated_at IS NULL
           AND scope IN (${scopes.map(() => '?').join(',')})
           AND (scope = 'global' OR cwd = ?)
         ORDER BY importance DESC, created_at DESC
         LIMIT ?`,
      )
      .all(...scopes, cwd, limit);
    const hits: MemorySearchHit[] = [];
    for (const row of rows) {
      if (isMemoryRow(row))
        hits.push({ ...toRecord(row), score: row.importance });
    }
    return hits;
  }

  /** Move a bank that cannot be opened out of the way, so `start()` can retry. */
  #quarantine(): void {
    const source = this.databasePath();
    if (!fs.existsSync(source)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      fs.renameSync(source, `${source}.broken-${stamp}`);
    } catch {
      // If it cannot even be moved aside, remove it: a bank is a cache of
      // things the agent wrote down, not a source of truth.
      fs.rmSync(source, { force: true });
    }
  }
}

function isCountRow(value: unknown): value is { n: number } {
  return typeof value === 'object' && value !== null && 'n' in value;
}

function toRecord(row: MemoryRow): MemoryRecord {
  const record: MemoryRecord = {
    id: row.id,
    content: row.content,
    scope: row.scope === 'global' ? 'global' : 'project',
    store: row.store === 'lesson' ? 'lesson' : 'fact',
    importance: row.importance,
    createdAt: row.created_at,
  };
  if (row.context !== null) record.context = row.context;
  if (row.source !== null) record.source = row.source;
  if (row.session_id !== null) record.sessionId = row.session_id;
  if (row.cwd !== null) record.cwd = row.cwd;
  return record;
}
