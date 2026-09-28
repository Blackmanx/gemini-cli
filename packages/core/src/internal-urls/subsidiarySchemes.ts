/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SESSION_FILE_PREFIX } from '../services/chatRecordingTypes.js';
import type { SkillDefinition } from '../skills/skillManager.js';
import { wrapUntrusted } from '../utils/textUtils.js';
import type {
  InternalResource,
  InternalUrl,
  ResolveContext,
  SchemeSpec,
  WriteContext,
} from './types.js';

/**
 * URL schemes that wrap a subsystem gemini-cli already has: recorded
 * transcripts, background processes, MCP resources, the memory bank,
 * discovered skills and spilled tool output.
 *
 * Each is registered only once the thing it wraps is reachable, and a
 * subsystem that is switched off says so in a clear error. An empty document
 * reads as "there is nothing there", which is a different — and wrong —
 * claim, and it is the one that sends a model looking in the wrong place.
 *
 * The host owns the wiring. `resolve` is synchronous, so the accessors below
 * hand over already-reachable data (a directory to scan, a session-scoped
 * process table, a connected MCP client) rather than promises; the integrator
 * builds them from the real subsystems. No scheme here opens a network
 * connection, spawns a process, or writes outside its declared write policy.
 */

/** One background process, as the session's process table reports it. */
export interface SubsidiaryProcess {
  /** Process id, as `proc://<id>` addresses it. */
  id: string;
  /** The command line the process was started with. */
  command: string;
  status: 'running' | 'exited';
  exitCode?: number | null;
  signal?: number | null;
}

/**
 * The calling session's background processes.
 *
 * The table is session-scoped by construction, so a `proc://` URL can only
 * ever reach a process the caller started — the same ownership check
 * `read_background_output` performs.
 */
export interface SubsidiaryProcessTable {
  /** Processes of this session, running and recently exited. */
  list(): SubsidiaryProcess[];
  /** Recent output of one process; `undefined` when it produced none. */
  output(id: string): string | undefined;
  /**
   * Send `input` to the process's stdin. `false` when the process cannot
   * accept input (already exited, or never had a terminal).
   */
  write(id: string, input: string): boolean;
  /**
   * Stop the process. Idempotent: stopping a process that is already stopped
   * succeeds without error, so a retried kill is not a failure.
   */
  kill(id: string): void;
}

/** One resource an already-connected MCP server exposes. */
export interface SubsidiaryMcpResourceRef {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/**
 * MCP access over the client's existing manager.
 *
 * The scheme never connects to a server itself: it asks the manager for the
 * resources it already discovered and reads through the client it already
 * holds, so a `mcp://` read costs no new connection and no new process.
 */
export interface SubsidiaryMcpAccess {
  /** Server names the manager knows, configured or connected. */
  servers(): string[];
  /** Resources discovered on one server. */
  resources(server: string): SubsidiaryMcpResourceRef[];
  /** Read one resource through that server's existing client. */
  read(server: string, uri: string): string;
}

/**
 * A file-backed memory bank. `LocalMemoryBackend` satisfies this as-is.
 *
 * Only the path is exposed: the backend's own operations are async, and a
 * clipped `recall` projection is not a safe basis for an update. The scheme
 * therefore reads the row itself, whole, from the same file the backend
 * writes — read-only, and never a second writer.
 */
export interface SubsidiaryMemoryBank {
  /** Absolute path of the bank's SQLite file. */
  databasePath(): string;
}

/**
 * Wiring the integrator supplies. Every accessor is a getter so a rebuilt
 * host (config reload, memory backend started mid-session) is picked up on
 * the next read; an accessor returning `undefined` means the subsystem is
 * switched off, which the scheme reports as such.
 */
export interface SubsidiarySchemeHost {
  /** Recorded session transcripts, or `undefined` when recording is off. */
  chatsDir?: () => string | undefined;
  /** Background-process table for the calling session, or `undefined` when off. */
  processes?: (sessionId: string) => SubsidiaryProcessTable | undefined;
  /** MCP access through the client's existing manager, or `undefined`. */
  mcp?: () => SubsidiaryMcpAccess | undefined;
  /** The memory bank, or `undefined` when the memory backend is off. */
  memory?: () => SubsidiaryMemoryBank | undefined;
  /** Discovered skills, or `undefined` when the skill subsystem is off. */
  skills?: () => readonly SkillDefinition[] | undefined;
  /** The `tool-outputs` directories spilled tool output is written to. */
  artifactDirs?: () => readonly string[];
}

/**
 * Shared narrowing helpers.
 *
 * These mirror the private helpers in `schemes.ts`; they are repeated rather
 * than exported so neither file has to change to accommodate the other.
 */

/** Node's errno-tagged error shape, narrowed without an unchecked assertion. */
function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string'
  );
}

function hasProperty<T extends string>(
  value: unknown,
  key: T,
): value is { [k in T]: unknown } {
  return value !== null && typeof value === 'object' && key in value;
}

/**
 * Whether `value` carries a string under `key`, narrowed to a named shape so
 * the read afterwards needs no assertion and no `typeof` on a computed key.
 */
function hasString<T extends string>(
  value: unknown,
  key: T,
): value is { [k in T]: string } {
  return hasProperty(value, key) && typeof value[key] === 'string';
}

/** One recorded message, as far as the transcript renderer cares. */
interface TranscriptRecord {
  id: string;
  type: string;
  timestamp: string;
  content: unknown;
  toolCalls: unknown;
}

function isTranscriptRecord(value: unknown): value is TranscriptRecord {
  return (
    hasString(value, 'id') &&
    hasString(value, 'type') &&
    hasString(value, 'timestamp')
  );
}

/** One content part carrying plain text, as most message parts do. */
interface TextPart {
  text: string;
}

function isTextPart(value: unknown): value is TextPart {
  return hasString(value, 'text');
}

function notFound(url: InternalUrl, what: string): never {
  throw new Error(`${url.href}: ${what} not found`);
}

function readFileOrThrow(file: string, url: InternalUrl, what: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = isErrnoException(err) ? err.code : undefined;
    if (code === 'ENOENT') notFound(url, what);
    throw new Error(`${url.href}: cannot read ${what}: ${String(err)}`);
  }
}

/** Reject any path segment that would escape the backing root. */
function safeJoin(root: string, relative: string, url: InternalUrl): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${url.href}: path escapes its root`);
  }
  return target;
}

/** A JSON object literal, as opposed to an array or a primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- history:// -------------------------------------------------------------

/** Transcript formats, newest first; a session is read from whichever exists. */
const SESSION_EXTENSIONS: readonly string[] = ['.jsonl', '.json'];

/** A session id is a transcript file-name fragment; anything else is rejected. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The id `history://` addresses a transcript by, or `undefined`. */
function sessionIdOf(file: string): string | undefined {
  if (!file.startsWith(SESSION_FILE_PREFIX)) return undefined;
  const ext = SESSION_EXTENSIONS.find((candidate) => file.endsWith(candidate));
  if (ext === undefined) return undefined;
  const id = file.slice(SESSION_FILE_PREFIX.length, -ext.length);
  return SESSION_ID_RE.test(id) ? id : undefined;
}

/** Path of the transcript for `id`, or `null` when no such session exists. */
function transcriptPath(
  dir: string,
  id: string,
  url: InternalUrl,
): string | null {
  for (const ext of SESSION_EXTENSIONS) {
    const file = safeJoin(dir, `${SESSION_FILE_PREFIX}${id}${ext}`, url);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * `history://<id>` — a recorded session, so the model can recover what a
 * previous run concluded instead of asking the user to paste it back.
 *
 * Read-only: a transcript is the harness's own record, and editing it would
 * make history say something that never happened.
 */
function historyScheme(host: SubsidiarySchemeHost): SchemeSpec {
  return {
    scheme: 'history',
    backing: 'file',
    selectors: 'lines',
    immutable: true,
    linkable: true,
    resolve(url: InternalUrl): InternalResource {
      const dir = host.chatsDir?.();
      if (dir === undefined) {
        throw new Error(
          'history:// is unavailable: chat recording is not enabled, so no session is recorded.',
        );
      }
      if (url.rest === '') {
        return {
          url: url.href,
          content: listSessions(dir),
          contentType: 'text/markdown',
          isDirectory: true,
          sourcePath: dir,
        };
      }
      if (!SESSION_ID_RE.test(url.rest)) {
        throw new Error(
          `${url.href}: ${url.rest} is not a session id. Read history:// to list the recorded ones.`,
        );
      }
      const file = transcriptPath(dir, url.rest, url);
      if (file === null) notFound(url, `session ${url.rest}`);
      const stats = fs.statSync(file);
      const raw = readFileOrThrow(file, url, `session ${url.rest}`);
      return {
        url: url.href,
        content: renderSession(url.rest, raw, stats),
        contentType: 'text/markdown',
        size: Buffer.byteLength(raw),
        sourcePath: file,
      };
    },
    locate(url: InternalUrl): string | null {
      const dir = host.chatsDir?.();
      if (dir === undefined) return null;
      if (url.rest === '') return dir;
      if (!SESSION_ID_RE.test(url.rest)) return null;
      return transcriptPath(dir, url.rest, url);
    },
    promptDoc(): string {
      return '`history://` — recorded sessions; `history://<id>` renders one as markdown.';
    },
  };
}

function listSessions(dir: string): string {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && sessionIdOf(entry.name) !== undefined)
    .map((entry) => {
      const stats = fs.statSync(path.join(dir, entry.name));
      return { id: sessionIdOf(entry.name) ?? entry.name, stats };
    })
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
  if (entries.length === 0) {
    return '# Sessions\n\nNo sessions have been recorded yet.';
  }
  return [
    '# Sessions',
    '',
    ...entries.map(
      (entry) =>
        `- \`history://${entry.id}\` — ${entry.stats.size} bytes, recorded ${entry.stats.mtime.toISOString()}`,
    ),
  ].join('\n');
}

function renderSession(id: string, raw: string, stats: fs.Stats): string {
  const records: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    records.push(renderRecord(line));
  }
  return [
    `# Session ${id}`,
    '',
    `- Recorded: ${stats.mtime.toISOString()}`,
    `- Transcript: ${stats.size} bytes, ${records.length} records`,
    '',
    ...(records.length === 0 ? ['_(no records)_'] : records),
  ].join('\n');
}

/** One JSONL line rendered as markdown; a line that is not JSON is kept as-is. */
function renderRecord(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return ['```', line, '```'].join('\n');
  }
  if (hasProperty(parsed, '$set')) return renderMetadata(parsed.$set);
  if (!isTranscriptRecord(parsed)) return jsonBlock(parsed);
  return renderMessage(parsed);
}

function jsonBlock(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

function renderMetadata(patch: unknown): string {
  if (!isPlainObject(patch)) return jsonBlock(patch);
  const lines: string[] = [];
  for (const key of [
    'sessionId',
    'kind',
    'startTime',
    'lastUpdated',
    'summary',
  ]) {
    const value = patch[key];
    if (typeof value === 'string' && value !== '') {
      lines.push(`- ${key}: ${value}`);
    }
  }
  return lines.length === 0 ? '_metadata update_' : lines.join('\n');
}

function renderMessage(record: TranscriptRecord): string {
  const sections = [
    `## ${record.type} — ${record.timestamp}`,
    '',
    renderParts(record.content),
  ];
  if (Array.isArray(record.toolCalls)) {
    for (const call of record.toolCalls) {
      sections.push('', renderToolCall(call));
    }
  }
  return sections.join('\n');
}

function renderParts(content: unknown): string {
  if (!Array.isArray(content)) return '_(no content)_';
  const chunks: string[] = [];
  for (const part of content) {
    chunks.push(isTextPart(part) ? part.text : jsonBlock(part));
  }
  return chunks.length === 0 ? '_(empty)_' : chunks.join('\n\n');
}

function renderToolCall(call: unknown): string {
  if (!isPlainObject(call)) return jsonBlock(call);
  const name = hasString(call, 'name') ? call.name : 'tool';
  return `#### ${name}\n\n\`${JSON.stringify(call['args'] ?? null)}\``;
}

// --- proc:// ---------------------------------------------------------------

/** The write target that stops a process rather than feeding it. */
const KILL_SUFFIX = '/kill';

/** The process id a `proc://` URL names, or `undefined` when it names none. */
function processIdOf(rest: string): string | undefined {
  if (rest === '' || rest.includes('/')) return undefined;
  return rest;
}

/**
 * `proc://<id>` — a background process of this session: what it is, whether
 * it is alive, and what it has printed.
 *
 * The only scheme here with a write surface, because a long-running process
 * is useless without a way to answer it or stop it. Writing sends stdin;
 * writing `proc://<id>/kill` stops it, and stopping an already-stopped
 * process is a reported success rather than an error, so a retried kill does
 * not look like a failed one.
 */
function procScheme(host: SubsidiarySchemeHost): SchemeSpec {
  return {
    scheme: 'proc',
    backing: 'virtual',
    selectors: 'lines',
    immutable: true,
    write: {
      via: 'handler',
      payload: 'verbatim',
      scope: 'device',
      // Feeding a running process is an execution: it acts on the input, and
      // stopping one ends a process the user may still be watching.
      tier: () => 'exec',
      contentOptional: (url: InternalUrl): boolean =>
        url.rest.endsWith(KILL_SUFFIX),
    },
    resolve(url: InternalUrl, context?: ResolveContext): InternalResource {
      const table = requireTable(host, context);
      if (url.rest === '') {
        return {
          url: url.href,
          content: listProcesses(table),
          contentType: 'text/plain',
        };
      }
      if (url.rest.endsWith(KILL_SUFFIX)) {
        const target = url.rest.slice(0, -KILL_SUFFIX.length);
        return {
          url: url.href,
          content: [
            `# Stop background process ${target}`,
            '',
            `Stop it with: \`write proc://${target}/kill\``,
            '',
            'Stopping an already-stopped process succeeds, so this is safe to retry.',
          ].join('\n'),
          contentType: 'text/markdown',
        };
      }
      const id = processIdOf(url.rest);
      if (id === undefined) {
        throw new Error(
          `${url.href}: name one background process, e.g. \`read proc://1234\`.`,
        );
      }
      const process = requireProcess(table, id);
      const output = table.output(id);
      const lines = [
        `# Process ${process.id}`,
        '',
        `- Status: ${process.status}`,
        `- Command: \`${process.command}\``,
      ];
      if (process.exitCode !== undefined) {
        lines.push(`- Exit code: ${String(process.exitCode)}`);
      }
      if (process.signal !== undefined && process.signal !== null) {
        lines.push(`- Signal: ${String(process.signal)}`);
      }
      lines.push('', '## Recent output', '');
      lines.push(
        output === undefined || output === ''
          ? '_(this process has produced no output)_'
          : ['```', output, '```'].join('\n'),
      );
      if (process.status === 'running') {
        lines.push(
          '',
          `Send it input with \`write proc://${process.id}\`, or stop it with \`write proc://${process.id}/kill\`.`,
        );
      }
      return {
        url: url.href,
        content: lines.join('\n'),
        contentType: 'text/markdown',
      };
    },
    applyWrite(
      url: InternalUrl,
      content: string,
      context?: WriteContext,
    ): void {
      const table = requireTable(host, context);
      if (url.rest.endsWith(KILL_SUFFIX)) {
        const target = url.rest.slice(0, -KILL_SUFFIX.length);
        // Re-reading the table before killing is what makes a retried kill a
        // success: the first one already moved the process to `exited`.
        if (requireProcess(table, target).status === 'running') {
          table.kill(target);
        }
        return;
      }
      const id = processIdOf(url.rest);
      if (id === undefined) {
        throw new Error(
          `${url.href}: name one background process, or write to \`proc://<id>/kill\` to stop it.`,
        );
      }
      requireProcess(table, id);
      if (!table.write(id, content)) {
        throw new Error(
          `proc://${id}: the process did not accept input. It has probably exited; read proc://${id} for its status and output.`,
        );
      }
    },
    promptDoc(): string {
      return "`proc://` — this session's background processes; `write proc://<id>` sends stdin and `write proc://<id>/kill` stops one.";
    },
  };
}

/** The calling session's process table, or a clear reason there is none. */
function requireTable(
  host: SubsidiarySchemeHost,
  context?: ResolveContext,
): SubsidiaryProcessTable {
  const table = host.processes?.(context?.sessionId ?? '');
  if (table === undefined) {
    throw new Error(
      'proc:// is unavailable: background processes are not enabled for this session.',
    );
  }
  return table;
}

/** One process of the table, or a miss that names the ones that do exist. */
function requireProcess(
  table: SubsidiaryProcessTable,
  id: string,
): SubsidiaryProcess {
  const processes = table.list();
  const found = processes.find((candidate) => candidate.id === id);
  if (found !== undefined) return found;
  const known = processes.map((candidate) => candidate.id).join(', ');
  throw new Error(
    `proc://${id}: no background process with that id in this session.` +
      (known
        ? ` Known ids: ${known}.`
        : ' No background processes are running.'),
  );
}

function listProcesses(table: SubsidiaryProcessTable): string {
  const processes = table.list();
  if (processes.length === 0) {
    return 'No background processes in this session.';
  }
  return processes
    .map(
      (process) =>
        `${process.id} ${process.status} \`${process.command}\`${
          process.exitCode === undefined || process.exitCode === null
            ? ''
            : ` (exit ${String(process.exitCode)})`
        }`,
    )
    .join('\n');
}

// --- mcp:// ----------------------------------------------------------------

/**
 * `mcp://<server>/<resource-uri>` — a resource served by an MCP server.
 *
 * The bytes are third-party content, so they come back wrapped as
 * untrusted, the same way `read_mcp_resource` returns them.
 */
function mcpScheme(host: SubsidiarySchemeHost): SchemeSpec {
  return {
    scheme: 'mcp',
    backing: 'remote',
    selectors: 'opaque',
    immutable: true,
    resolve(url: InternalUrl): InternalResource {
      const access = host.mcp?.();
      if (access === undefined) {
        throw new Error(
          'mcp:// is unavailable: no MCP client manager is installed.',
        );
      }
      if (url.rest === '') {
        return {
          url: url.href,
          content: listMcpServers(access),
          contentType: 'text/plain',
        };
      }
      const slash = url.rest.indexOf('/');
      if (slash <= 0 || slash === url.rest.length - 1) {
        throw new Error(
          `${url.href}: address a resource as \`mcp://<server>/<resource-uri>\`. Read mcp:// to list the servers.`,
        );
      }
      const server = url.rest.slice(0, slash);
      const uri = url.rest.slice(slash + 1);
      const known = access.servers();
      if (!known.includes(server)) {
        throw new Error(
          `mcp://${server}: no such MCP server.` +
            (known.length > 0
              ? ` Known servers: ${known.join(', ')}.`
              : ' No MCP servers are configured.'),
        );
      }
      const content = access.read(server, uri);
      return {
        url: url.href,
        content: wrapUntrusted(content),
        contentType: 'text/plain',
        size: Buffer.byteLength(content),
      };
    },
    promptDoc(): string {
      return '`mcp://` — configured MCP servers; `mcp://<server>/<resource-uri>` reads one of their resources.';
    },
  };
}

function listMcpServers(access: SubsidiaryMcpAccess): string {
  const servers = access.servers();
  if (servers.length === 0) return 'No MCP servers are configured.';
  const lines: string[] = [];
  for (const server of servers) {
    const resources = access.resources(server);
    lines.push(`- ${server} (${resources.length} resources)`);
    for (const resource of resources) {
      const label = resource.name ?? resource.uri;
      lines.push(
        `  - ${resource.uri}${label === resource.uri ? '' : ` — ${label}`}`,
      );
    }
  }
  return lines.join('\n');
}

// --- memory:// -------------------------------------------------------------

/** A cell value that survives `JSON.stringify` unchanged. */
type MemoryCell = string | number | boolean | null;

function memoryCell(value: unknown): MemoryCell {
  if (value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

/**
 * `memory://<id>` — one stored memory, whole.
 *
 * The record is read from the bank's own table rather than from a `recall`
 * projection: a clipped search hit is a pointer, not a row, and an update
 * built on a pointer silently drops the fields the search never showed.
 */
function memoryScheme(host: SubsidiarySchemeHost): SchemeSpec {
  return {
    scheme: 'memory',
    backing: 'virtual',
    selectors: 'opaque',
    immutable: true,
    resolve(url: InternalUrl): InternalResource {
      const bank = host.memory?.();
      if (bank === undefined) {
        throw new Error(
          'memory:// is unavailable: the memory backend is not enabled.',
        );
      }
      const file = bank.databasePath();
      if (!fs.existsSync(file)) {
        throw new Error(
          'memory:// is unavailable: the memory backend is enabled but its bank has not been created yet.',
        );
      }
      if (url.rest === '') {
        return {
          url: url.href,
          content: listMemories(file, url),
          contentType: 'application/json',
        };
      }
      const row = readMemoryRow(file, url.rest, url);
      if (row === undefined) {
        throw new Error(
          `${url.href}: no memory with that id. Read memory:// to list the stored ones.`,
        );
      }
      const content = JSON.stringify(row, null, 2);
      return {
        url: url.href,
        content,
        contentType: 'application/json',
        size: Buffer.byteLength(content),
        // A single record is a discrete value: it comes back whole, with no
        // line selector and no paging.
        shape: 'value',
      };
    },
    promptDoc(): string {
      return '`memory://` — stored memories; `memory://<id>` returns one complete record as JSON.';
    },
  };
}

/** Run one read-only query against the bank and close it again. */
function withMemoryDb<T>(
  file: string,
  url: InternalUrl,
  query: (db: DatabaseSync) => T,
): T {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    throw new Error(`${url.href}: cannot open the memory bank: ${String(err)}`);
  }
  try {
    return query(db);
  } catch (err) {
    throw new Error(`${url.href}: cannot read the memory bank: ${String(err)}`);
  } finally {
    db.close();
  }
}

function readMemoryRow(
  file: string,
  id: string,
  url: InternalUrl,
): Record<string, MemoryCell> | undefined {
  return withMemoryDb(file, url, (db) => {
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (row === undefined) return undefined;
    const record: Record<string, MemoryCell> = {};
    for (const [column, value] of Object.entries(row)) {
      record[column] = memoryCell(value);
    }
    return record;
  });
}

function listMemories(file: string, url: InternalUrl): string {
  const rows = withMemoryDb(file, url, (db) =>
    db
      .prepare(
        `SELECT id, content, scope, importance, created_at
             FROM memories
            WHERE invalidated_at IS NULL
            ORDER BY created_at DESC
            LIMIT 100`,
      )
      .all(),
  );
  if (rows.length === 0) return JSON.stringify({ memories: [] }, null, 2);
  return JSON.stringify(
    {
      memories: rows.map((row) => ({
        url: `memory://${String(row['id'])}`,
        content: String(row['content']),
        scope: String(row['scope']),
        importance: memoryCell(row['importance']),
        createdAt: String(row['created_at']),
      })),
    },
    null,
    2,
  );
}

// --- skill:// --------------------------------------------------------------

/**
 * `skill://<name>` — a discovered skill's body.
 *
 * The listing carries the description, because that is what decides which
 * skill is worth reading; the body is the payload, returned as written.
 */
function skillScheme(host: SubsidiarySchemeHost): SchemeSpec {
  return {
    scheme: 'skill',
    backing: 'file',
    selectors: 'lines',
    immutable: true,
    linkable: true,
    resolve(url: InternalUrl): InternalResource {
      const skills = host.skills?.();
      if (skills === undefined) {
        throw new Error(
          'skill:// is unavailable: the skill subsystem is not enabled.',
        );
      }
      if (url.rest === '') {
        return {
          url: url.href,
          content: listSkills(skills),
          contentType: 'text/markdown',
          isDirectory: true,
        };
      }
      const skill = findSkill(skills, url.rest);
      if (skill === undefined) {
        throw new Error(
          `${url.href}: no such skill.` +
            (skills.length > 0
              ? ` Known skills: ${skills.map((s) => s.name).join(', ')}.`
              : ' No skills have been discovered.'),
        );
      }
      return {
        url: url.href,
        content: skill.body,
        contentType: 'text/markdown',
        size: Buffer.byteLength(skill.body),
        sourcePath: skill.location,
      };
    },
    locate(url: InternalUrl): string | null {
      const skills = host.skills?.();
      if (skills === undefined || url.rest === '') return null;
      return findSkill(skills, url.rest)?.location ?? null;
    },
    promptDoc(): string {
      return "`skill://` — discovered skills; `skill://<name>` returns a skill's body.";
    },
  };
}

function findSkill(
  skills: readonly SkillDefinition[],
  name: string,
): SkillDefinition | undefined {
  const wanted = name.toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === wanted);
}

function listSkills(skills: readonly SkillDefinition[]): string {
  if (skills.length === 0) return '# Skills\n\nNo skills have been discovered.';
  return [
    '# Skills',
    '',
    ...skills.map(
      (skill) => `- \`skill://${skill.name}\` — ${skill.description}`,
    ),
  ].join('\n');
}

// --- artifact:// -----------------------------------------------------------

/**
 * `artifact://<id>` — spilled tool output at full size.
 *
 * A truncated tool result points here for the rest; reading it back through
 * the same limit would defeat the spill, so this scheme is unbounded and is
 * itself the spill store.
 */
function artifactScheme(host: SubsidiarySchemeHost): SchemeSpec {
  return {
    scheme: 'artifact',
    backing: 'file',
    selectors: 'lines',
    immutable: true,
    linkable: true,
    unbounded: true,
    artifactStore: true,
    compactTranscript: true,
    resolve(url: InternalUrl): InternalResource {
      const dirs = host.artifactDirs?.() ?? [];
      if (dirs.length === 0) {
        throw new Error(
          'artifact:// is unavailable: no spilled-output directory is configured.',
        );
      }
      if (url.rest === '') {
        return {
          url: url.href,
          content: listArtifacts(dirs),
          contentType: 'text/plain',
          isDirectory: true,
        };
      }
      const file = artifactPath(dirs, url.rest, url);
      if (file === null) notFound(url, `spilled output ${url.rest}`);
      const content = readFileOrThrow(file, url, `spilled output ${url.rest}`);
      return {
        url: url.href,
        content,
        contentType: 'text/plain',
        size: Buffer.byteLength(content),
        sourcePath: file,
      };
    },
    locate(url: InternalUrl): string | null {
      const dirs = host.artifactDirs?.() ?? [];
      const first = dirs[0];
      if (first === undefined) return null;
      if (url.rest === '') return first;
      return artifactPath(dirs, url.rest, url);
    },
    promptDoc(): string {
      return '`artifact://` — spilled tool output; `artifact://<id>` returns one in full.';
    },
  };
}

/**
 * Locate one spill across the configured directories.
 *
 * `saveTruncatedToolOutput` names spills `<tool>_<id>.txt` inside
 * `tool-outputs/`, optionally under a per-session subdirectory, and a
 * session's spills are flattened into one namespace here so the id a tool
 * reported keeps resolving.
 */
function artifactPath(
  dirs: readonly string[],
  id: string,
  url: InternalUrl,
): string | null {
  for (const dir of dirs) {
    for (const candidate of [id, `${id}.txt`]) {
      const file = safeJoin(dir, candidate, url);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return null;
}

function listArtifacts(dirs: readonly string[]): string {
  const seen: string[] = [];
  for (const dir of dirs) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const stats = fs.statSync(path.join(dir, entry.name));
      seen.push(`- ${entry.name} (${stats.size} bytes)`);
    }
  }
  if (seen.length === 0) return 'No tool output has been spilled.';
  return ['# Spilled tool output', '', ...seen.sort()].join('\n');
}

/** Every scheme that wraps an existing gemini-cli subsystem, in prompt order. */
export function subsidiarySchemeSpecs(
  host: SubsidiarySchemeHost,
): SchemeSpec[] {
  return [
    historyScheme(host),
    procScheme(host),
    mcpScheme(host),
    memoryScheme(host),
    skillScheme(host),
    artifactScheme(host),
  ];
}
