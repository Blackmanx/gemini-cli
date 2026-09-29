/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * URL schemes for the three things a session reaches for that are not the
 * workspace file it is editing: the merge conflicts sitting in one, the
 * issues and pull requests it was asked to work on, and the files on the
 * user's own SSH hosts.
 *
 * `conflict://` is the only writable one, because it is the only one whose
 * job is to change what the model is already looking at. It replaces one
 * recorded marker block and nothing else, and a bulk write is all-or-nothing
 * per file: a half-resolved merge is worse than an unresolved one, because the
 * file then looks resolved and is not.
 *
 * The other two read through the user's own `gh` and `ssh`, handed over by the
 * host — no network connection is opened here, and nothing falls back to a
 * local file of the same name, which would quietly show the wrong bytes. A
 * subsystem that is switched off, missing or refusing says so in a clear
 * error. An empty document reads as "there is nothing there", which is a
 * different — and wrong — claim, and it is the one that sends a model looking
 * in the wrong place.
 *
 * Both GitHub and a remote read are network calls, so both handlers are
 * asynchronous: `gh` and `ssh` are the user's own processes, reached through
 * the host, and waiting on one must not block the event loop the TUI renders
 * on. The host hands over the transport and nothing else — argument
 * construction, payload narrowing, filters, rendering and failure diagnosis
 * all live here, once per read.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  describeGhFailure,
  GH_UNAVAILABLE_MESSAGE,
  type GhResult,
} from '../services/ghService.js';
import { getErrorMessage } from '../utils/errors.js';
import { wrapUntrusted } from '../utils/textUtils.js';
import type {
  InternalResource,
  InternalUrl,
  InternalWriteResult,
  ResolveContext,
  SchemeSpec,
  WriteContext,
} from './types.js';

/**
 * Shared narrowing helpers.
 *
 * These mirror the private helpers in `schemes.ts` and `subsidiarySchemes.ts`;
 * they are repeated rather than exported so no existing file has to change to
 * accommodate this one.
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

/** A JSON object literal, as opposed to an array or a primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Posix single-quote a value so a remote shell receives it verbatim. */
function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// --- conflict:// ------------------------------------------------------------

const OURS_MARKER = '<<<<<<<';
const BASE_MARKER = '|||||||';
const SEPARATOR_MARKER = '=======';
const THEIRS_MARKER = '>>>>>>>';

/** The write target that resolves every conflict in a file, not one of them. */
const ALL_CONFLICTS = '*';

/** One recorded side of a merge conflict, as its marker block records it. */
export interface ConflictBlock {
  /** 1-based file line of the `<<<<<<<` opener. */
  startLine: number;
  /** 1-based file line of the `=======` separator. */
  separatorLine: number;
  /** 1-based file line of the `>>>>>>>` closer. */
  endLine: number;
  /** Label after the opener, when git wrote one (`HEAD`, a branch name). */
  oursLabel?: string;
  /** Label after the `|||||||` base marker, on a diff3 conflict. */
  baseLabel?: string;
  /** Label after the closer, when git wrote one. */
  theirsLabel?: string;
  /** Ours side, LF-normalized, without its marker. */
  oursLines: string[];
  /** Base side of a diff3 conflict; absent on a two-way merge. */
  baseLines?: string[];
  /** Theirs side, LF-normalized, without its marker. */
  theirsLines: string[];
}

/** A conflict block plus the id `conflict://` addresses it by. */
export interface ConflictEntry extends ConflictBlock {
  /** Stable id, reused for the same block across re-reads. */
  id: number;
  /** Absolute path of the file the block lives in. */
  file: string;
}

/** Where a block was registered, so a re-read reuses its id. */
function locationKey(file: string, startLine: number): string {
  return `${file}\u0000${String(startLine)}`;
}

/**
 * Per-session log of the conflict regions the model has been shown.
 *
 * Ids are what make a resolve addressable at all: the file keeps shifting
 * under the model as other conflicts are resolved, so a line number is not a
 * stable handle but a block's content is. The registry re-uses the id a block
 * already has for the same file and opener line, and drops the id once the
 * block is gone — which is what turns a second resolve of the same conflict
 * into a clear "no such conflict" rather than a wrong edit.
 *
 * Ids are per registry, so a write is only ever meaningful against the view
 * that produced it.
 */
export class ConflictRegistry {
  #nextId = 1;
  #entries = new Map<number, ConflictEntry>();
  #idsByLocation = new Map<string, number>();

  /**
   * Scan `file` and register every conflict it still holds, dropping entries
   * whose block is no longer there. Returns the file's live entries in file
   * order.
   *
   * This is the only registration point: `conflict://<file>` calls it on every
   * read, and so does a read tool that surfaces merge markers, so the ids a
   * model is quoted and the ids a write accepts can never diverge.
   */
  scan(file: string): ConflictEntry[] {
    const blocks = scanConflictLines(readConflictFile(file).split('\n'));
    const live = new Set<string>();
    for (const block of blocks) live.add(locationKey(file, block.startLine));
    const prefix = `${file}\u0000`;
    for (const [key, id] of [...this.#idsByLocation]) {
      if (!key.startsWith(prefix) || live.has(key)) continue;
      this.#idsByLocation.delete(key);
      this.#entries.delete(id);
    }
    const entries: ConflictEntry[] = [];
    for (const block of blocks) {
      entries.push(this.#register(file, block));
    }
    entries.sort((a, b) => a.startLine - b.startLine);
    return entries;
  }

  /** Every registered entry, in id order. */
  entries(): ConflictEntry[] {
    return [...this.#entries.values()].sort((a, b) => a.id - b.id);
  }

  /** One entry by id, or `undefined` when no such conflict is registered. */
  get(id: number): ConflictEntry | undefined {
    return this.#entries.get(id);
  }

  /** Drop the given ids; a resolve removes the block it replaced. */
  invalidate(ids: readonly number[]): void {
    for (const id of ids) {
      const entry = this.#entries.get(id);
      if (entry === undefined) continue;
      this.#idsByLocation.delete(locationKey(entry.file, entry.startLine));
      this.#entries.delete(id);
    }
  }

  #register(file: string, block: ConflictBlock): ConflictEntry {
    const key = locationKey(file, block.startLine);
    const existing = this.#idsByLocation.get(key);
    if (existing !== undefined) {
      // Re-read: keep the id, refresh the recorded sides so a splice always
      // reflects what is on disk now.
      const entry: ConflictEntry = { ...block, id: existing, file };
      this.#entries.set(existing, entry);
      return entry;
    }
    const id = this.#nextId++;
    const entry: ConflictEntry = { ...block, id, file };
    this.#idsByLocation.set(key, id);
    this.#entries.set(id, entry);
    return entry;
  }
}

function readConflictFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = isErrnoException(err) ? err.code : undefined;
    if (code === 'ENOENT') {
      throw new Error(`conflict://: ${file} does not exist`);
    }
    throw new Error(
      `conflict://: cannot read ${file}: ${getErrorMessage(err)}`,
    );
  }
}

/**
 * The label after a marker prefix when the line is a valid column-0 marker, or
 * `null` when it is not. Strict shape: prefix alone, or prefix plus a single
 * space plus a label.
 */
function matchMarker(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null;
  if (line.length === prefix.length) return '';
  if (line.charCodeAt(prefix.length) !== 32) return null;
  return line.slice(prefix.length + 1);
}

function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** A block being assembled, before a closer proves it complete. */
interface PartialConflict {
  startLine: number;
  oursLabel?: string;
  oursLines: string[];
  baseLabel?: string;
  baseLines?: string[];
  separatorLine?: number;
  theirsLines?: string[];
}

/**
 * Scan file lines for completed conflict blocks.
 *
 * Only fully-closed blocks are returned. A block whose closer is past the end
 * of what was read is not a conflict the model can resolve, and reporting it
 * would hand out an id that can never be written.
 */
export function scanConflictLines(lines: readonly string[]): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  let phase: 'idle' | 'ours' | 'base' | 'theirs' = 'idle';
  let partial: PartialConflict | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = stripTrailingCr(lines[i]);
    const lineNumber = i + 1;

    const oursLabel = matchMarker(line, OURS_MARKER);
    if (oursLabel !== null) {
      partial = { startLine: lineNumber, oursLines: [] };
      if (oursLabel !== '') partial.oursLabel = oursLabel;
      phase = 'ours';
      continue;
    }

    if (phase === 'idle' || partial === null) continue;
    // Bound once: `partial` is reassigned to `null` on every early exit below,
    // which drops the narrowing a `let` would otherwise keep.
    const open = partial;

    const baseLabel = matchMarker(line, BASE_MARKER);
    if (baseLabel !== null) {
      if (phase !== 'ours') {
        partial = null;
        phase = 'idle';
        continue;
      }
      open.baseLines = [];
      if (baseLabel !== '') open.baseLabel = baseLabel;
      phase = 'base';
      continue;
    }

    if (line === SEPARATOR_MARKER) {
      if (phase === 'ours' || phase === 'base') {
        open.separatorLine = lineNumber;
        open.theirsLines = [];
        phase = 'theirs';
      } else {
        partial = null;
        phase = 'idle';
      }
      continue;
    }

    const theirsLabel = matchMarker(line, THEIRS_MARKER);
    if (theirsLabel !== null) {
      const separatorLine = open.separatorLine;
      const theirsLines = open.theirsLines;
      if (
        phase === 'theirs' &&
        separatorLine !== undefined &&
        theirsLines !== undefined
      ) {
        const block: ConflictBlock = {
          startLine: open.startLine,
          separatorLine,
          endLine: lineNumber,
          oursLines: open.oursLines,
          theirsLines,
        };
        if (open.baseLines !== undefined) block.baseLines = open.baseLines;
        if (open.oursLabel !== undefined) block.oursLabel = open.oursLabel;
        if (open.baseLabel !== undefined) block.baseLabel = open.baseLabel;
        if (theirsLabel !== '') block.theirsLabel = theirsLabel;
        blocks.push(block);
      }
      partial = null;
      phase = 'idle';
      continue;
    }

    if (phase === 'ours') {
      open.oursLines.push(line);
    } else if (phase === 'base' && open.baseLines !== undefined) {
      open.baseLines.push(line);
    } else if (phase === 'theirs' && open.theirsLines !== undefined) {
      open.theirsLines.push(line);
    }
  }

  return blocks;
}

/** Reconstruct the recorded marker block as it should appear in the file. */
function markerLines(entry: ConflictEntry): string[] {
  const lines: string[] = [];
  lines.push(
    entry.oursLabel ? `${OURS_MARKER} ${entry.oursLabel}` : OURS_MARKER,
  );
  lines.push(...entry.oursLines);
  if (entry.baseLines !== undefined) {
    lines.push(
      entry.baseLabel ? `${BASE_MARKER} ${entry.baseLabel}` : BASE_MARKER,
    );
    lines.push(...entry.baseLines);
  }
  lines.push(SEPARATOR_MARKER);
  lines.push(...entry.theirsLines);
  lines.push(
    entry.theirsLabel ? `${THEIRS_MARKER} ${entry.theirsLabel}` : THEIRS_MARKER,
  );
  return lines;
}

/**
 * Find the recorded block inside `lines` by content, preferring the opener
 * line it was registered at.
 *
 * Anchoring on content rather than on a line number is what lets an id survive
 * an out-of-band edit earlier in the file — and it is what makes a block that
 * really did change surface as a miss instead of corrupting the file.
 */
function locateBlock(
  lines: readonly string[],
  expected: readonly string[],
  preferredIdx: number,
): { startIdx: number; endIdx: number } | null {
  if (expected.length === 0 || expected.length > lines.length) return null;
  if (matchesAt(lines, preferredIdx, expected)) {
    return {
      startIdx: preferredIdx,
      endIdx: preferredIdx + expected.length - 1,
    };
  }
  const limit = lines.length - expected.length;
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= limit; i++) {
    if (!matchesAt(lines, i, expected)) continue;
    const distance = Math.abs(i - preferredIdx);
    if (distance >= bestDistance) continue;
    best = i;
    bestDistance = distance;
  }
  if (best === null) return null;
  return { startIdx: best, endIdx: best + expected.length - 1 };
}

function matchesAt(
  lines: readonly string[],
  startIdx: number,
  expected: readonly string[],
): boolean {
  if (startIdx < 0 || startIdx + expected.length > lines.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (stripTrailingCr(lines[startIdx + i]) !== expected[i]) return false;
  }
  return true;
}

/**
 * Replace the block `entry` records with `replacement` (markers included) and
 * return the new file text.
 *
 * Only the block is replaced: the lines above and below it stay exactly as
 * they were, because a resolve that also reformats the file around the
 * conflict is a resolve nobody asked for.
 */
function spliceBlock(
  text: string,
  entry: ConflictEntry,
  replacement: string,
): string {
  const lines = text.split('\n');
  const match = locateBlock(lines, markerLines(entry), entry.startLine - 1);
  if (match === null) {
    throw new Error(
      `Conflict #${String(entry.id)} is no longer present in ${entry.file}: its marker block cannot be located. The file changed since the conflict was registered — re-read it to get current ids.`,
    );
  }
  const trimmed = replacement.endsWith('\n')
    ? replacement.slice(0, -1)
    : replacement;
  const replacementLines = trimmed.split('\n').map(stripTrailingCr);
  // Recorded sides are LF-normalized; put the file's own line ending back so
  // a CRLF checkout round-trips instead of ending up half-mixed.
  if (lines[match.startIdx].endsWith('\r')) {
    const hasFollowingLine = match.endIdx + 1 < lines.length;
    const last = replacementLines.length - 1;
    replacementLines.forEach((line, i) => {
      if (i < last || hasFollowingLine) replacementLines[i] = `${line}\r`;
    });
  }
  return [
    ...lines.slice(0, match.startIdx),
    ...replacementLines,
    ...lines.slice(match.endIdx + 1),
  ].join('\n');
}

/**
 * Expand `@ours` / `@theirs` / `@base` / `@both` against `entry`.
 *
 * A token only fires when it is the whole line, so a real `@both` in a line of
 * prose or code is left alone; every other line passes through verbatim, so a
 * hand-written resolution lands exactly as written.
 */
function expandTokens(content: string, entry: ConflictEntry): string {
  const out: string[] = [];
  for (const raw of content.split('\n')) {
    const line = stripTrailingCr(raw);
    if (line === '@ours') {
      out.push(...entry.oursLines);
    } else if (line === '@theirs') {
      out.push(...entry.theirsLines);
    } else if (line === '@both') {
      out.push(...entry.oursLines, ...entry.theirsLines);
    } else if (line === '@base') {
      if (entry.baseLines === undefined) {
        throw new Error(
          `Conflict #${String(entry.id)} has no base section (it is a two-way merge). \`@base\` only applies to a diff3 conflict.`,
        );
      }
      out.push(...entry.baseLines);
    } else {
      out.push(raw);
    }
  }
  return out.join('\n');
}

/** A per-id directive line: `#3: @theirs`, `3 = @ours`, and so on. */
const BULK_DIRECTIVE_RE = /^#?(\d+)\s*[:=]\s*(@ours|@theirs|@base|@both)$/;

/** The head of a directive line whose value is not a valid side token. */
const BULK_DIRECTIVE_HEAD_RE = /^#?\d+\s*[:=]/;

function truncateLine(line: string): string {
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/**
 * Parse per-id directives out of a bulk write's content.
 *
 * `null` means "no directive lines at all", which is a uniform write of the
 * same content into every block. A block that mixes directives with anything
 * else is refused: treating it as uniform would paste the directive text
 * itself into every conflict and report success.
 */
function parseBulkDirectives(content: string): Map<number, string> | null {
  const directives = new Map<number, string>();
  const stray: string[] = [];
  let sawDirective = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const match = BULK_DIRECTIVE_RE.exec(line);
    if (match === null) {
      stray.push(line);
      continue;
    }
    sawDirective = true;
    const id = Number.parseInt(match[1], 10);
    if (directives.has(id)) {
      throw new Error(
        `conflict://: the bulk write names conflict #${String(id)} twice — each id may appear once.`,
      );
    }
    directives.set(id, match[2]);
  }
  if (!sawDirective) return null;
  if (stray.length > 0) {
    const sample = truncateLine(stray[0]);
    const hint = BULK_DIRECTIVE_HEAD_RE.test(sample)
      ? 'A per-id bulk accepts only the tokens @ours/@theirs/@base/@both, one side per id on a single line. '
      : '';
    throw new Error(
      `conflict://: ${String(stray.length)} line(s) of the bulk write are not \`<id>: @side\` directives (first: \`${sample}\`). ${hint}Resolve a block with hand-written content through \`write conflict://<file>/<id>\` instead.`,
    );
  }
  return directives;
}

/** A `conflict://` target: a file, and optionally the conflict inside it. */
interface ConflictTarget {
  file: string;
  /** A conflict number or `*`, without the leading slash; absent for a listing. */
  id: string | undefined;
}

const CONFLICT_ID_RE = /^\d+$/;

function decodeConflictPath(rest: string, url: InternalUrl): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    throw new Error(`${url.href}: invalid percent-escape in the path.`);
  }
  if (decoded.includes('\u0000')) {
    throw new Error(`${url.href}: the path contains a NUL byte.`);
  }
  return decoded;
}

function parseConflictTarget(rest: string, url: InternalUrl): ConflictTarget {
  if (rest === '') {
    throw new Error(
      "conflict:// needs a file: `conflict://<file>` lists a file's conflicts and `conflict://<file>/<id>` shows one.",
    );
  }
  const decoded = decodeConflictPath(rest, url);
  const slash = decoded.lastIndexOf('/');
  if (slash <= 0) return { file: decoded, id: undefined };
  const tail = decoded.slice(slash + 1);
  if (tail !== ALL_CONFLICTS && !CONFLICT_ID_RE.test(tail)) {
    return { file: decoded, id: undefined };
  }
  const file = decoded.slice(0, slash);
  if (file === '') {
    throw new Error(`${url.href}: name the file before the conflict id.`);
  }
  return { file, id: tail };
}

/**
 * Absolute path a `conflict://` file names: an absolute path is taken as
 * written, anything else is relative to the calling session's directory.
 */
function conflictFile(
  file: string,
  context: ResolveContext | undefined,
): string {
  if (path.isAbsolute(file)) return path.resolve(file);
  return path.resolve(context?.cwd ?? process.cwd(), file);
}

function requireRegistry(host: ConflictSchemeHost): ConflictRegistry {
  const registry = host.conflicts?.();
  if (registry === undefined) {
    throw new Error(
      'conflict:// is unavailable: no conflict registry is wired into this session.',
    );
  }
  return registry;
}

function conflictRange(entry: ConflictEntry): string {
  return entry.startLine === entry.endLine
    ? `L${String(entry.startLine)}`
    : `L${String(entry.startLine)}-L${String(entry.endLine)}`;
}

function conflictWord(count: number): string {
  return count === 1 ? 'conflict' : 'conflicts';
}

function knownIds(entries: readonly ConflictEntry[]): string {
  return entries.map((entry) => `#${String(entry.id)}`).join(', ');
}

/**
 * `conflict://<file>[/<id>]` — the merge conflicts in a file, and the only way
 * to resolve them.
 *
 * The listing is what a model reads once a file has surfaced a marker block,
 * and the ids in it are what a write addresses. A write replaces exactly one
 * recorded block — or, with `/*`, every block in that file — and leaves the
 * rest of the file byte for byte as it was.
 */
function conflictScheme(host: ConflictSchemeHost): SchemeSpec {
  return {
    scheme: 'conflict',
    backing: 'virtual',
    selectors: 'lines',
    immutable: false,
    write: {
      via: 'handler',
      payload: 'text',
      scope: 'workspace',
      // Resolving a conflict discards one side of the user's work in a file
      // they own, so it is a write, never a read.
      tier: () => 'write',
    },
    async resolve(
      url: InternalUrl,
      context?: ResolveContext,
    ): Promise<InternalResource> {
      const registry = requireRegistry(host);
      const target = parseConflictTarget(url.rest, url);
      const file = conflictFile(target.file, context);
      const entries = registry.scan(file);
      if (entries.length === 0) {
        throw new Error(`${url.href}: ${file} has no unresolved conflicts.`);
      }
      if (target.id === undefined) {
        const content = listConflicts(entries, file);
        return {
          url: url.href,
          content,
          contentType: 'text/markdown',
          size: Buffer.byteLength(content),
        };
      }
      if (target.id === ALL_CONFLICTS) {
        throw new Error(
          `${url.href}: \`/*\` is write-only. Read \`${url.href.replace(/\/\*$/, '')}\` to list the conflicts, or \`conflict://<file>/<id>\` to inspect one.`,
        );
      }
      const entry = requireEntry(entries, registry, target.id, url, file);
      const content = renderConflict(entry);
      return {
        url: url.href,
        content,
        contentType: 'text/markdown',
        size: Buffer.byteLength(content),
      };
    },
    async applyWrite(
      url: InternalUrl,
      content: string,
      context?: WriteContext,
    ): Promise<InternalWriteResult> {
      return resolveConflicts(host, url, content, context);
    },
    promptDoc(): string {
      return '`conflict://<file>` — unresolved merge conflicts in a file; `write conflict://<file>/<id>` (or `/<id>/*`) resolves one, or all, with `@ours`/`@theirs`/`@base`/`@both`.';
    },
  };
}

function listConflicts(
  entries: readonly ConflictEntry[],
  file: string,
): string {
  const lines = [
    `# Conflicts in ${file}`,
    '',
    `${String(entries.length)} unresolved ${conflictWord(entries.length)}.`,
    '',
  ];
  for (const entry of entries) {
    const kind = entry.baseLines === undefined ? '' : '  (3-way)';
    lines.push(`- #${String(entry.id)}  ${conflictRange(entry)}${kind}`);
  }
  const labels = conflictLabels(entries);
  if (labels.length > 0) lines.push('', ...labels);
  lines.push(
    '',
    `Inspect one with \`read conflict://<file>/<id>\`.`,
    `Resolve one with \`write conflict://<file>/<id>\` and a body of \`@ours\`, \`@theirs\`, \`@base\` or \`@both\` (or hand-written lines).`,
    `Resolve the whole file with \`write conflict://<file>/*\`; the body may instead be one \`<id>: @side\` line per conflict.`,
    'A write replaces the marker block only — never repeat the lines around it.',
  );
  return lines.join('\n');
}

function conflictLabels(entries: readonly ConflictEntry[]): string[] {
  const ours = entries.find((entry) => entry.oursLabel !== undefined);
  const theirs = entries.find((entry) => entry.theirsLabel !== undefined);
  const base = entries.find((entry) => entry.baseLines !== undefined);
  const lines: string[] = [];
  if (ours?.oursLabel !== undefined) lines.push(`- ours: ${ours.oursLabel}`);
  if (theirs?.theirsLabel !== undefined) {
    lines.push(`- theirs: ${theirs.theirsLabel}`);
  }
  if (base !== undefined)
    lines.push(`- base: ${base.baseLabel ?? '(no label)'}`);
  return lines;
}

function renderConflict(entry: ConflictEntry): string {
  const lines = [
    `# Conflict #${String(entry.id)} — ${conflictRange(entry)}`,
    '',
  ];
  for (const [name, value] of [
    ['ours', entry.oursLabel],
    ['base', entry.baseLabel],
    ['theirs', entry.theirsLabel],
  ] as const) {
    if (value === undefined) continue;
    lines.push(`- ${name}: ${value}`);
  }
  lines.push(
    '',
    '## Ours',
    '',
    '```',
    ...entry.oursLines,
    '```',
    '',
    '## Theirs',
    '',
    '```',
    ...entry.theirsLines,
    '```',
    '',
    '## Base',
    '',
  );
  lines.push(
    ...(entry.baseLines === undefined
      ? ['_(no base section — this is a two-way merge)_']
      : ['```', ...entry.baseLines, '```']),
    '',
    `Resolve it with \`write conflict://<file>/${String(entry.id)}\` and a body of \`@ours\`, \`@theirs\`, \`@base\` or \`@both\`, or with hand-written lines. The write replaces the marker block only.`,
  );
  return lines.join('\n');
}

/**
 * Resolve one conflict, or every conflict in the file.
 *
 * The new text is assembled entirely in memory and written once, so a bad id
 * anywhere in a bulk write leaves every conflict in the file exactly as it was
 * — a partially resolved merge is worse than an unresolved one, because the
 * file then looks resolved and is not.
 */
async function resolveConflicts(
  host: ConflictSchemeHost,
  url: InternalUrl,
  content: string,
  context: WriteContext | undefined,
): Promise<InternalWriteResult> {
  const registry = requireRegistry(host);
  const target = parseConflictTarget(url.rest, url);
  if (target.id === undefined) {
    throw new Error(
      `${url.href}: conflict://<file> only lists. Write conflict://<file>/<id> to resolve one, or conflict://<file>/* to resolve them all.`,
    );
  }
  const file = conflictFile(target.file, context);
  const entries = registry.scan(file);
  if (entries.length === 0) {
    throw new Error(
      `${url.href}: ${file} has no unresolved conflicts, so there is nothing to resolve.`,
    );
  }

  const bulk = target.id === ALL_CONFLICTS;
  const directives = bulk ? parseBulkDirectives(content) : null;
  const selected = bulk
    ? selectBulk(entries, directives, url)
    : [requireEntry(entries, registry, target.id, url, file)];

  let text = readConflictFile(file);
  for (const entry of [...selected].sort((a, b) => b.startLine - a.startLine)) {
    const body = directives?.get(entry.id) ?? content;
    text = spliceBlock(text, entry, expandTokens(body, entry));
  }
  fs.writeFileSync(file, text, 'utf8');
  registry.invalidate(selected.map((entry) => entry.id));

  const name = path.relative(context?.cwd ?? process.cwd(), file) || file;
  const resolved = selected
    .map((entry) => `#${String(entry.id)} (${conflictRange(entry)})`)
    .join(', ');
  const summary = [
    `Resolved ${String(selected.length)} ${conflictWord(selected.length)} in ${name}: ${resolved}.`,
  ];
  if (directives !== null) {
    const remaining = entries.filter((entry) => !directives.has(entry.id));
    if (remaining.length > 0) {
      summary.push(
        `${String(remaining.length)} ${conflictWord(remaining.length)} in this file are still unresolved (${knownIds(remaining)}).`,
      );
    }
  }
  return {
    content: summary.join('\n'),
    details: {
      label: `resolve ${String(selected.length)} ${conflictWord(selected.length)} in ${name}`,
      notes: [`conflict://${url.rest}`],
    },
  };
}

/**
 * The conflicts a bulk write touches: every one of them for a uniform body, or
 * exactly the listed ids for a per-id body. An id that names no live conflict
 * is refused before anything is written.
 */
function selectBulk(
  entries: readonly ConflictEntry[],
  directives: Map<number, string> | null,
  url: InternalUrl,
): ConflictEntry[] {
  if (directives === null) return [...entries];
  const unknown = [...directives.keys()].filter(
    (id) => !entries.some((entry) => entry.id === id),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${url.href}: the bulk write names ${unknown.map((id) => `#${String(id)}`).join(', ')}, which ${unknown.length === 1 ? 'is not a' : 'are not'} live ${unknown.length === 1 ? 'conflict' : 'conflicts'} in this file. This file has ${knownIds(entries)} — nothing was written.`,
    );
  }
  return entries.filter((entry) => directives.has(entry.id));
}

/** One live conflict of a file, or a miss that says which ids do exist. */
function requireEntry(
  entries: readonly ConflictEntry[],
  registry: ConflictRegistry,
  id: string,
  url: InternalUrl,
  file: string,
): ConflictEntry {
  const number = Number.parseInt(id, 10);
  const found = entries.find((entry) => entry.id === number);
  if (found !== undefined) return found;
  const elsewhere = registry.get(number);
  if (elsewhere !== undefined) {
    throw new Error(
      `${url.href}: conflict #${id} belongs to ${elsewhere.file}, not ${file}. ${file} has ${knownIds(entries)}.`,
    );
  }
  throw new Error(
    `${url.href}: no conflict #${id} in ${file}. This file has ${knownIds(entries)} — an id stops being valid once its conflict is resolved, so re-read conflict://<file> for the current ones.`,
  );
}

// --- pr:// and issue:// ----------------------------------------------------

/** Which GitHub URL shape a spec serves. */
type GhScheme = 'pr' | 'issue';

/** What each scheme calls its items, in prose and in a list heading. */
const GH_ITEM_WORDS: Readonly<
  Record<GhScheme, { item: string; plural: string }>
> = {
  pr: { item: 'pull request', plural: 'Pull requests' },
  issue: { item: 'issue', plural: 'Issues' },
};

const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 100;

const PR_STATES: readonly string[] = ['open', 'closed', 'merged', 'all'];
const ISSUE_STATES: readonly string[] = ['open', 'closed', 'all'];

/** A `gh` miss: the item number does not exist, or is not visible. */
const GH_MISS_RE =
  /could not resolve to|no (pull request|issues?) found|not found|http 404/i;

/** An `owner/repo` pair, optionally on a GitHub Enterprise host. */
interface GhRepoRef {
  /** Enterprise host, or `undefined` for github.com. */
  host: string | undefined;
  /** The `owner/repo` string `gh -R` takes. */
  ref: string;
}

/** What one `pr://`/`issue://` URL addresses. */
type GhTarget =
  | {
      kind: 'list';
      repo: GhRepoRef | undefined;
      state: string;
      limit: number;
      author: string | undefined;
      label: string | undefined;
    }
  | {
      kind: 'single';
      repo: GhRepoRef | undefined;
      number: number;
      comments: boolean;
    }
  | {
      kind: 'diff';
      repo: GhRepoRef | undefined;
      number: number;
      mode: 'list' | 'all' | 'slice';
      index: number | undefined;
    };

/**
 * `-R [HOST/]OWNER/REPO` for `gh`. The host goes inside the repo argument,
 * not into a `--hostname` flag: `gh pr view` and `gh pr list` have no such
 * flag, and the combined form is what every `gh` subcommand accepts.
 */
function repoArgs(repo: GhRepoRef | undefined): string[] {
  return repo === undefined ? [] : ['-R', ghRepoPath(repo)];
}

function decodeComponent(value: string, url: InternalUrl): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${url.href}: invalid percent-escape in the URL.`);
  }
}

/** Split `rest` into its path and its `?key=value` filters. */
/** Split `rest` into its path and its `?key=value` filters. */
function splitQuery(
  rest: string,
  url: InternalUrl,
): { path: string; query: Record<string, string> } {
  const mark = rest.indexOf('?');
  if (mark === -1) return { path: rest, query: {} };
  const query: Record<string, string> = {};
  for (const pair of rest.slice(mark + 1).split('&')) {
    if (pair === '') continue;
    const equals = pair.indexOf('=');
    const key = equals === -1 ? pair : pair.slice(0, equals);
    if (key === '') continue;
    const value = equals === -1 ? '' : pair.slice(equals + 1);
    query[decodeComponent(key, url)] = decodeComponent(
      value.replaceAll('+', ' '),
      url,
    );
  }
  return { path: rest.slice(0, mark), query };
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : undefined;
}

/**
 * Parse a `pr://`/`issue://` URL into what it addresses.
 *
 * The shapes are, each optionally prefixed with an enterprise `<host>/`:
 * `scheme://` (list the session's repository), `scheme://<owner>/<repo>` (list
 * that one), `scheme://<number>` and `scheme://<owner>/<repo>/<number>` (one
 * item), and `pr://<number>/diff[/all|<i>]`.
 *
 * A dotted first segment can only be a host, because GitHub owner names are
 * alphanumeric-plus-hyphen. A single-label host (`ghe`) is only recognizable
 * from the number's position, so it is accepted in the numbered form alone —
 * `<host>/<owner>/<repo>` with no number is indistinguishable from
 * `<owner>/<repo>/<bad-number>`, and the honest error beats a guess.
 */
function parseGhTarget(
  scheme: GhScheme,
  rest: string,
  query: Record<string, string>,
  url: InternalUrl,
): GhTarget {
  const { path: rawPath } = splitQuery(rest, url);
  const trimmed = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
  let parts: string[] = [];
  if (trimmed !== '') {
    for (const segment of trimmed.split('/')) {
      const decoded = decodeComponent(segment, url);
      if (decoded === '' || decoded === '.' || decoded === '..') {
        throw new Error(`${url.href}: empty or unsafe path segment.`);
      }
      parts.push(segment);
    }
  }

  // Peel `/diff`, `/diff/all` and `/diff/<i>` off the end, but only when what
  // remains really does end in an item number. That is what keeps
  // `pr://owner/diff` — a repository named "diff" — a valid listing.
  let diffTail: string[] = [];
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (
    parts.length > 1 &&
    last === 'diff' &&
    positiveInt(secondLast) !== undefined
  ) {
    diffTail = [last];
  } else if (
    parts.length > 2 &&
    secondLast === 'diff' &&
    (last === 'all' || positiveInt(last) !== undefined) &&
    positiveInt(parts[parts.length - 3]) !== undefined
  ) {
    diffTail = parts.slice(-2);
  }
  if (diffTail.length > 0) {
    parts = parts.slice(0, parts.length - diffTail.length);
  }

  // Peel an enterprise `<host>/` prefix. A dotted first segment can only be a
  // host, because GitHub owner names are alphanumeric-plus-hyphen. A
  // single-label host (`ghe`) is only unambiguous in the fully numbered form
  // `<host>/<owner>/<repo>/<n>`, which is the one shape it is accepted in.
  let host: string | undefined;
  if (parts.length >= 2 && parts[0].includes('.')) {
    host = parts[0];
    parts = parts.slice(1);
  } else if (parts.length === 4 && positiveInt(parts[3]) !== undefined) {
    host = parts[0];
    parts = parts.slice(1);
  }

  if (parts.length === 0) {
    return { kind: 'list', ...listOptions(scheme, query, undefined, url) };
  }
  if (parts.length === 1) {
    const number = positiveInt(parts[0]);
    if (number === undefined) {
      throw new Error(
        `${url.href}: '${parts[0]}' is neither a ${scheme}:// number nor <owner>/<repo>. Read ${scheme}://<owner>/<repo> to list a repository, or ${scheme}://<number> for one item.`,
      );
    }
    return diffTail.length > 0
      ? parseDiffTail(scheme, url, number, undefined, diffTail)
      : {
          kind: 'single',
          repo: undefined,
          number,
          comments: commentsWanted(query['comments']),
        };
  }

  const repo: GhRepoRef = { host, ref: `${parts[0]}/${parts[1]}` };
  if (parts.length === 2) {
    return { kind: 'list', ...listOptions(scheme, query, repo, url) };
  }
  if (parts.length > 3) {
    throw new Error(
      `${url.href}: unexpected trailing segment '${parts[3]}'. Read ${scheme}://<owner>/<repo>/<number> for one item.`,
    );
  }
  const number = positiveInt(parts[2]);
  if (number === undefined) {
    throw new Error(`${url.href}: '${parts[2]}' is not a ${scheme}:// number.`);
  }
  return diffTail.length > 0
    ? parseDiffTail(scheme, url, number, repo, diffTail)
    : {
        kind: 'single',
        repo,
        number,
        comments: commentsWanted(query['comments']),
      };
}

/** `/diff`, `/diff/all` and `/diff/<i>` after a pull request number. */
function parseDiffTail(
  scheme: GhScheme,
  url: InternalUrl,
  number: number,
  repo: GhRepoRef | undefined,
  tail: readonly string[],
): GhTarget {
  if (scheme === 'issue') {
    throw new Error(
      `${url.href}: an issue has no diff. Read pr://<owner>/<repo>/<number>/diff for a pull request.`,
    );
  }
  if (tail.length === 1 && tail[0] === 'diff') {
    return { kind: 'diff', repo, number, mode: 'list', index: undefined };
  }
  if (tail.length === 2 && tail[0] === 'diff') {
    if (tail[1] === 'all') {
      return { kind: 'diff', repo, number, mode: 'all', index: undefined };
    }
    const index = positiveInt(tail[1]);
    if (index !== undefined) {
      return { kind: 'diff', repo, number, mode: 'slice', index };
    }
  }
  throw new Error(
    `${url.href}: '${tail.join('/')}' is not a pr:// diff selector. Use \`diff\`, \`diff/all\`, or \`diff/<i>\` with a 1-indexed file number.`,
  );
}

/** List filters. `repo` is absent until the caller's directory resolves it. */
function listOptions(
  scheme: GhScheme,
  query: Record<string, string>,
  repo: GhRepoRef | undefined,
  url: InternalUrl,
): {
  repo: GhRepoRef | undefined;
  state: string;
  limit: number;
  author: string | undefined;
  label: string | undefined;
} {
  const allowed = scheme === 'pr' ? PR_STATES : ISSUE_STATES;
  const state = query['state'] ?? 'open';
  if (!allowed.includes(state)) {
    throw new Error(
      `${url.href}: '${state}' is not a ${scheme}:// state. Expected one of: ${allowed.join(', ')}.`,
    );
  }
  const rawLimit = query['limit'];
  let limit = LIST_LIMIT_DEFAULT;
  if (rawLimit !== undefined) {
    const parsed = positiveInt(rawLimit);
    if (parsed === undefined) {
      throw new Error(
        `${url.href}: '${rawLimit}' is not a ${scheme}:// limit. Expected a positive integer (max ${String(LIST_LIMIT_MAX)}).`,
      );
    }
    limit = Math.min(parsed, LIST_LIMIT_MAX);
  }
  return { repo, state, limit, author: query['author'], label: query['label'] };
}

function commentsWanted(value: string | undefined): boolean {
  if (value === undefined) return true;
  const lowered = value.toLowerCase();
  return !(lowered === '0' || lowered === 'false' || lowered === 'no');
}

function sessionCwd(context?: ResolveContext): string {
  return context?.cwd ?? process.cwd();
}

async function runGh(
  access: ConflictGitHub,
  args: readonly string[],
  cwd: string,
  url: InternalUrl,
): Promise<GhResult> {
  try {
    return await access.run(args, { cwd });
  } catch (err) {
    throw new Error(
      `${url.href}: cannot run \`gh ${args.join(' ')}\`: ${getErrorMessage(err)}. ${GH_UNAVAILABLE_MESSAGE}`,
    );
  }
}

/**
 * One `gh` invocation that must produce JSON, with a miss reported as a miss.
 *
 * `gh` answers "no such pull request" with a non-zero exit and a terse
 * message. Passing that through as a generic failure would read as "the read
 * broke"; naming the item and the exact command that looked for it is what
 * lets the model correct the number instead of retrying the same thing.
 */
async function ghJson(
  access: ConflictGitHub,
  args: readonly string[],
  cwd: string,
  url: InternalUrl,
  what: string,
  repo: GhRepoRef | undefined,
): Promise<unknown> {
  const result = await runGh(access, args, cwd, url);
  const invocation = `gh ${args.join(' ')}`;
  if (result.exitCode !== 0) {
    const detail = `${result.stderr} ${result.stdout}`;
    if (GH_MISS_RE.test(detail)) {
      throw new Error(
        `${url.href}: ${what} not found, or not visible to this account. ${await invisibleBecause(access, repo, cwd)}Looked for it with \`${invocation}\` in ${cwd}.`,
      );
    }
    throw new Error(`${url.href}: ${describeGhFailure(args, result)}`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (err) {
    throw new Error(
      `${url.href}: \`${invocation}\` returned output that is not JSON: ${getErrorMessage(err)}`,
    );
  }
}

function ghField(payload: unknown, key: string): unknown {
  return isPlainObject(payload) ? payload[key] : undefined;
}

function ghText(payload: unknown, key: string): string | undefined {
  const value = ghField(payload, key);
  return typeof value === 'string' ? value : undefined;
}

function ghCount(payload: unknown, key: string): number | undefined {
  const value = ghField(payload, key);
  return typeof value === 'number' ? value : undefined;
}

function ghList(payload: unknown, key: string): unknown[] {
  const value = ghField(payload, key);
  return Array.isArray(value) ? value : [];
}

function ghLogin(payload: unknown, key: string): string {
  const login = ghText(ghField(payload, key), 'login');
  return login === undefined ? 'unknown' : `@${login}`;
}

function ghLabels(payload: unknown): string[] {
  return ghList(payload, 'labels')
    .map((label) => ghText(label, 'name'))
    .filter((name): name is string => name !== undefined && name !== '');
}

/** The `<owner>/<repo>` half of a URL, with its enterprise host. */
function ghRepoPath(repo: GhRepoRef): string {
  return `${repo.host === undefined ? '' : `${repo.host}/`}${repo.ref}`;
}

/** `owner/repo#12` or `ghe.example.com/owner/repo#12` — a heading. */
function ghRef(repo: GhRepoRef, suffix: string): string {
  return `${ghRepoPath(repo)}${suffix}`;
}

/** `owner/repo/<n><suffix>` — a URL that can be read back. */
function ghItemPath(repo: GhRepoRef, suffix: string): string {
  return `${ghRepoPath(repo)}/${suffix}`;
}

function singleFields(scheme: GhScheme, comments: boolean): string {
  const common =
    'number,title,body,state,author,labels,createdAt,updatedAt,url';
  if (scheme === 'issue') return comments ? `${common},comments` : common;
  const pr =
    'isDraft,baseRefName,headRefName,additions,deletions,changedFiles,mergeable';
  return comments ? `${common},${pr},comments` : `${common},${pr}`;
}

function requireGitHub(
  host: ConflictSchemeHost,
  url: InternalUrl,
): ConflictGitHub {
  const access = host.github?.();
  if (access === undefined) {
    throw new Error(
      `${url.href} is unavailable: no GitHub transport is wired into this session. ${GH_UNAVAILABLE_MESSAGE}`,
    );
  }
  return access;
}

/** The repository a short URL means: the one the session is working in. */
/**
 * The half of a 404 that *is* decidable, said out loud.
 *
 * GitHub answers "this item does not exist" and "you may not see this item"
 * with the same 404 and, over GraphQL, the same message — nothing in the
 * response tells them apart, so no wording here claims to. What one extra
 * probe does settle is the repository around it: if `gh repo view` can read
 * it, this account sees the repository and the number is what to check; if it
 * cannot, the repository is out of reach and the name or the account is.
 * That is worth a round trip, because it is the one case where the two
 * advices genuinely differ.
 */
async function invisibleBecause(
  access: ConflictGitHub,
  repo: GhRepoRef | undefined,
  cwd: string,
): Promise<string> {
  if (repo === undefined) return '';
  let result: GhResult;
  try {
    // `gh repo view` takes the repository positionally, not through `-R`.
    result = await access.run(
      ['repo', 'view', ghRepoPath(repo), '--json', 'nameWithOwner'],
      { cwd },
    );
  } catch {
    return '';
  }
  if (result.exitCode === 0) {
    return `${repo.ref} is visible to this account, so the item number is the thing to check. `;
  }
  // Only a 404 says "not visible"; any other failure says nothing about it,
  // and claiming otherwise would be worse than staying quiet.
  if (!GH_MISS_RE.test(`${result.stderr} ${result.stdout}`)) return '';
  return `${repo.ref} is not visible to this account either, so check the repository name and that the account has access. `;
}

async function defaultRepo(
  access: ConflictGitHub,
  scheme: GhScheme,
  cwd: string,
  url: InternalUrl,
): Promise<GhRepoRef> {
  const payload = await ghJson(
    access,
    ['repo', 'view', '--json', 'nameWithOwner'],
    cwd,
    url,
    `a repository for ${scheme}:// (looked for one in ${cwd})`,
    undefined,
  );
  const nameWithOwner = ghText(payload, 'nameWithOwner');
  if (nameWithOwner === undefined || !nameWithOwner.includes('/')) {
    throw new Error(
      `${url.href}: cannot tell which repository ${scheme}:// means from ${cwd}. Read ${scheme}://<owner>/<repo> instead.`,
    );
  }
  return { host: undefined, ref: nameWithOwner };
}

async function resolveRepo(
  access: ConflictGitHub,
  scheme: GhScheme,
  repo: GhRepoRef | undefined,
  cwd: string,
  url: InternalUrl,
): Promise<GhRepoRef> {
  return repo ?? defaultRepo(access, scheme, cwd, url);
}

function renderComments(payload: unknown, comments: boolean): string[] {
  if (!comments) return [];
  const list = ghList(payload, 'comments');
  if (list.length === 0) return ['', '## Comments', '', '_No comments._'];
  const lines = ['', `## Comments (${String(list.length)})`, ''];
  for (const comment of list) {
    const created = ghText(comment, 'createdAt');
    const who = ghLogin(comment, 'author');
    const body = ghText(comment, 'body') ?? '';
    lines.push(
      `### ${who}${created === undefined ? '' : ` · ${created}`}`,
      '',
      wrapUntrusted(body),
      '',
    );
  }
  return lines;
}

/**
 * One issue or pull request as markdown.
 *
 * The body and every comment are wrapped as untrusted: they are written by
 * whoever filed the item, and a `pr://` read is exactly the moment a
 * repository gets to say "ignore your instructions".
 */
function renderItem(
  scheme: GhScheme,
  payload: unknown,
  repo: GhRepoRef,
  number: number,
  comments: boolean,
): string {
  const title = ghText(payload, 'title') ?? '(no title)';
  const state = ghText(payload, 'state') ?? 'unknown';
  const draft = ghField(payload, 'isDraft') === true ? ' (draft)' : '';
  const labels = ghLabels(payload);
  const lines = [
    `# ${ghRef(repo, `#${String(number)}`)} — ${title}`,
    '',
    `- State: ${state}${draft}`,
    `- Author: ${ghLogin(payload, 'author')}`,
  ];
  if (labels.length > 0) lines.push(`- Labels: ${labels.join(', ')}`);
  const created = ghText(payload, 'createdAt');
  if (created !== undefined) lines.push(`- Created: ${created}`);
  const updated = ghText(payload, 'updatedAt');
  if (updated !== undefined) lines.push(`- Updated: ${updated}`);
  if (scheme === 'pr') {
    const base = ghText(payload, 'baseRefName');
    const head = ghText(payload, 'headRefName');
    if (base !== undefined || head !== undefined) {
      lines.push(`- Branch: ${base ?? '?'} ← ${head ?? '?'}`);
    }
    const additions = ghCount(payload, 'additions');
    const deletions = ghCount(payload, 'deletions');
    const changed = ghCount(payload, 'changedFiles');
    if (additions !== undefined || deletions !== undefined) {
      lines.push(
        `- Changes: +${String(additions ?? 0)} −${String(deletions ?? 0)} across ${String(changed ?? 0)} file(s)`,
      );
    }
  }
  const webUrl = ghText(payload, 'url');
  if (webUrl !== undefined) lines.push(`- URL: ${webUrl}`);
  lines.push('', '## Description', '');
  const body = ghText(payload, 'body') ?? '';
  lines.push(body === '' ? '_No description._' : wrapUntrusted(body));
  lines.push(...renderComments(payload, comments));
  if (scheme === 'pr') {
    lines.push(
      '',
      `The diff is at \`${scheme}://${ghItemPath(repo, `${String(number)}/diff`)}\` — add \`/all\` for the whole diff or \`/<i>\` for one file.`,
    );
  }
  return lines.join('\n');
}

function renderList(
  scheme: GhScheme,
  items: readonly unknown[],
  repo: GhRepoRef,
  state: string,
): string {
  const words = GH_ITEM_WORDS[scheme];
  const heading = `# ${words.plural} — ${repo.ref} (${state})`;
  if (items.length === 0) {
    return [
      heading,
      '',
      `No ${state} ${words.plural.toLowerCase()} in ${repo.ref}.`,
    ].join('\n');
  }
  const lines = [heading, ''];
  for (const item of items) {
    const number = ghCount(item, 'number');
    const ref = number === undefined ? '' : String(number);
    const itemState = ghText(item, 'state')?.toLowerCase() ?? '?';
    const draft = ghField(item, 'isDraft') === true ? ' draft' : '';
    const when = ghText(item, 'updatedAt') ?? '';
    const labels = ghLabels(item);
    lines.push(
      `- [${itemState}${draft}]${ref === '' ? '' : ` #${ref}`}  ${ghLogin(item, 'author')}${when === '' ? '' : `  ${when}`}`,
      `    ${ghText(item, 'title') ?? '(no title)'}${labels.length > 0 ? `  (${labels.join(', ')})` : ''}`,
    );
    if (ref !== '') lines.push(`    ${scheme}://${ghItemPath(repo, ref)}`);
  }
  return lines.join('\n');
}

const PR_FILE_FIELDS = 'files';

function renderDiffIndex(
  files: readonly unknown[],
  repo: GhRepoRef,
  number: number,
): string {
  const heading = `# Diff — ${ghRef(repo, `#${String(number)}`)}`;
  if (files.length === 0) {
    return [heading, '', 'This pull request changes no files.'].join('\n');
  }
  const lines = [heading, '', `${String(files.length)} changed file(s):`, ''];
  files.forEach((file, i) => {
    const name = ghText(file, 'path') ?? '(unknown file)';
    const additions = ghCount(file, 'additions') ?? 0;
    const deletions = ghCount(file, 'deletions') ?? 0;
    lines.push(
      `${String(i + 1)}. \`${name}\`  +${String(additions)} −${String(deletions)}`,
    );
  });
  lines.push(
    '',
    `Read one with \`read pr://${ghItemPath(repo, `${String(number)}/diff/1`)}\` … \`/${String(files.length)}\`, or the whole diff with \`read pr://${ghItemPath(repo, `${String(number)}/diff/all`)}\`.`,
  );
  return lines.join('\n');
}

/** One file's section of a unified diff. */
interface DiffSection {
  path: string;
  text: string;
}

const DIFF_HEADER_RE = /^diff --git /;

function splitDiff(diff: string): DiffSection[] {
  const lines = diff.split('\n');
  const sections: DiffSection[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (DIFF_HEADER_RE.test(line)) {
      if (current !== null) sections.push(makeSection(current));
      current = [line];
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) sections.push(makeSection(current));
  return sections;
}

function makeSection(lines: readonly string[]): DiffSection {
  const header = lines[0];
  const bAt = header === undefined ? -1 : header.lastIndexOf(' b/');
  const path = bAt === -1 ? '(unknown file)' : header.slice(bAt + 3);
  return { path, text: lines.join('\n') };
}

/**
 * `pr://…` and `issue://…` — one issue or pull request, its diff, or a list of
 * them, read through the user's own `gh`.
 *
 * Read-only by construction: no spec here declares a write policy, so nothing
 * can comment, label or close anything through a URL. Bodies and comments come
 * back wrapped as untrusted, because they are written by whoever filed the
 * item.
 */
function githubScheme(scheme: GhScheme, host: ConflictSchemeHost): SchemeSpec {
  return {
    scheme,
    backing: 'remote',
    selectors: 'opaque',
    immutable: true,
    async resolve(
      url: InternalUrl,
      context?: ResolveContext,
    ): Promise<InternalResource> {
      const access = requireGitHub(host, url);
      const cwd = sessionCwd(context);
      const query = splitQuery(url.rest, url).query;
      const target = parseGhTarget(scheme, url.rest, query, url);
      const words = GH_ITEM_WORDS[scheme];

      const repo = await resolveRepo(access, scheme, target.repo, cwd, url);

      if (target.kind === 'list') {
        const args = [
          scheme,
          'list',
          '--state',
          target.state,
          '--limit',
          String(target.limit),
          ...(target.author === undefined ? [] : ['--author', target.author]),
          ...(target.label === undefined ? [] : ['--label', target.label]),
          ...repoArgs(repo),
          '--json',
          'number,title,state,author,labels,updatedAt,url',
        ];
        const payload = await ghJson(
          access,
          args,
          cwd,
          url,
          `${words.plural.toLowerCase()} in ${repo.ref}`,
          repo,
        );
        const items = Array.isArray(payload) ? payload : [];
        return {
          url: url.href,
          content: renderList(scheme, items, repo, target.state),
          contentType: 'text/markdown',
        };
      }

      const number = String(target.number);
      const item = `${words.item} #${number} in ${repo.ref}`;

      if (target.kind === 'single') {
        const args = [
          scheme,
          'view',
          number,
          ...repoArgs(repo),
          '--json',
          singleFields(scheme, target.comments),
        ];
        const payload = await ghJson(access, args, cwd, url, item, repo);
        const content = renderItem(
          scheme,
          payload,
          repo,
          target.number,
          target.comments,
        );
        return {
          url: url.href,
          content,
          contentType: 'text/markdown',
          size: Buffer.byteLength(content),
        };
      }

      return resolveDiff(
        access,
        url,
        repo,
        target.number,
        target.mode,
        target.index,
        cwd,
      );
    },
    promptDoc(): string {
      if (scheme === 'pr') {
        return '`pr://<n>` — a pull request; `/diff` lists its files, `/diff/all` is the whole diff, `/diff/<i>` is one file. `pr://<owner>/<repo>/<n>` and `pr://<host>/<owner>/<repo>/<n>` for other repositories.';
      }
      return '`issue://<n>` — an issue; `issue://<owner>/<repo>/<n>` and `issue://<host>/<owner>/<repo>/<n>` for other repositories. `issue://` or `issue://<owner>/<repo>` lists them.';
    },
  };
}

async function resolveDiff(
  access: ConflictGitHub,
  url: InternalUrl,
  repo: GhRepoRef,
  number: number,
  mode: 'list' | 'all' | 'slice',
  index: number | undefined,
  cwd: string,
): Promise<InternalResource> {
  const item = `pull request #${String(number)} in ${repo.ref}`;
  if (mode === 'list') {
    const args = [
      'pr',
      'view',
      String(number),
      ...repoArgs(repo),
      '--json',
      PR_FILE_FIELDS,
    ];
    const payload = await ghJson(
      access,
      args,
      cwd,
      url,
      `${item} (its changed files)`,
      repo,
    );
    const files = ghList(payload, 'files');
    return {
      url: url.href,
      content: renderDiffIndex(files, repo, number),
      contentType: 'text/markdown',
    };
  }

  const args = ['pr', 'diff', String(number), ...repoArgs(repo)];
  const result = await runGh(access, args, cwd, url);
  if (result.exitCode !== 0) {
    const detail = `${result.stderr} ${result.stdout}`;
    if (GH_MISS_RE.test(detail)) {
      throw new Error(
        `${url.href}: ${item} not found, or not visible to this account. ${await invisibleBecause(access, repo, cwd)}Looked for it with \`gh ${args.join(' ')}\` in ${cwd}.`,
      );
    }
    throw new Error(`${url.href}: ${describeGhFailure(args, result)}`);
  }
  if (mode === 'all') {
    return {
      url: url.href,
      content: result.stdout,
      contentType: 'text/plain',
      size: Buffer.byteLength(result.stdout),
    };
  }

  const sections = splitDiff(result.stdout);
  const wanted = index ?? 1;
  const section = sections[wanted - 1];
  if (section === undefined) {
    throw new Error(
      `${url.href}: ${item} changes ${String(sections.length)} file(s), so there is no file #${String(wanted)}. Read \`pr://${ghItemPath(repo, `${String(number)}/diff`)}\` for the list, or \`/diff/all\` for the whole diff.`,
    );
  }
  const content = [
    `# ${item} — ${section.path}`,
    '',
    '```diff',
    section.text,
    '```',
  ].join('\n');
  return {
    url: url.href,
    content,
    contentType: 'text/markdown',
    size: Buffer.byteLength(content),
  };
}

// --- ssh:// -----------------------------------------------------------------

/** Largest remote file `ssh://` will materialize. */
const SSH_TEXT_MAX_BYTES = 1024 * 1024;

/** Exit status the read command uses to say "that path is a directory". */
const SSH_DIRECTORY_EXIT = 3;

interface SshTarget {
  host: string;
  port: number | undefined;
}

/**
 * Split `ssh://[user@]host[:port]/<path>` into the destination and the
 * absolute remote path.
 *
 * A port is part of the authority, not a line selector, which is what
 * `portAuthority` on the spec guarantees to the router: `ssh://host:2222`
 * peels nothing, and `ssh://host:2222/etc/hosts` keeps the port with the
 * host.
 */
function parseSshTarget(
  rest: string,
  url: InternalUrl,
): { target: SshTarget; remotePath: string } {
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const remotePath = slash === -1 ? '' : rest.slice(slash);
  if (remotePath === '') {
    throw new Error(
      `${url.href}: ssh:// needs a path, e.g. \`ssh://${authority}/etc/hosts\`. Read \`ssh://\` for the configured hosts.`,
    );
  }
  return { target: parseSshAuthority(authority, url), remotePath };
}

function parseSshAuthority(authority: string, url: InternalUrl): SshTarget {
  const at = authority.lastIndexOf('@');
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  const colon = hostPort.lastIndexOf(':');
  const isBracketedIpv6 = hostPort.startsWith('[') && hostPort.endsWith(']');
  const hasPort = colon !== -1 && colon > 0 && !isBracketedIpv6;
  const host = hasPort ? hostPort.slice(0, colon) : hostPort;
  const bareHost =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bareHost === '') {
    throw new Error(
      `${url.href}: ssh:// requires a host, e.g. \`ssh://<host>/<path>\`.`,
    );
  }
  if (!hasPort) return { host: bareHost, port: undefined };
  const port = Number.parseInt(hostPort.slice(colon + 1), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${url.href}: '${hostPort.slice(colon + 1)}' is not a port. Use \`ssh://host:<1-65535>/<path>\` or drop the port.`,
    );
  }
  return { host: bareHost, port };
}

function requireSsh(host: ConflictSchemeHost, url: InternalUrl): ConflictSsh {
  const access = host.ssh?.();
  if (access === undefined) {
    throw new Error(
      `${url.href} is unavailable: no SSH transport is wired into this session.`,
    );
  }
  return access;
}

async function runSsh(
  access: ConflictSsh,
  target: SshTarget,
  command: string,
  url: InternalUrl,
): Promise<ConflictSshResult> {
  try {
    return await access.run(target, command);
  } catch (err) {
    throw new Error(
      `${url.href}: cannot run a command on ${target.host} over ssh: ${getErrorMessage(err)}. ssh:// needs a remote shell that can run POSIX commands — nothing is read from a local file of the same name instead.`,
    );
  }
}

function listSshHosts(hosts: readonly ConflictSshHost[]): string {
  if (hosts.length === 0) {
    return [
      '# SSH hosts',
      '',
      'No SSH hosts are configured. Add one to your ssh config, or read `ssh://<host>/<path>` for any destination your ssh setup can resolve.',
    ].join('\n');
  }
  const lines = [
    '# SSH hosts',
    '',
    `${String(hosts.length)} configured ${hosts.length === 1 ? 'host' : 'hosts'}:`,
    '',
  ];
  for (const host of hosts) {
    const where = [
      host.username === undefined ? '' : `${host.username}@`,
      host.host ?? host.name,
      host.port === undefined ? '' : `:${String(host.port)}`,
    ].join('');
    const note = host.description === undefined ? '' : ` — ${host.description}`;
    lines.push(`- \`ssh://${host.name}/\`${note}  (${where})`);
  }
  return lines.join('\n');
}

/**
 * `ssh://<host>/<path>` — a UTF-8 text file on one of the user's own SSH
 * hosts, read through the user's own `ssh`.
 *
 * Read-only, capped at 1 MiB, and never satisfied from the local filesystem:
 * a host that cannot be reached, or a remote without a usable shell, is an
 * error naming that fact. Falling back to a same-named local path would
 * return a real file that is not the one the URL names, which is the one
 * failure mode a remote read cannot have.
 */
function sshScheme(host: ConflictSchemeHost): SchemeSpec {
  return {
    scheme: 'ssh',
    backing: 'remote',
    selectors: 'lines',
    immutable: true,
    portAuthority: true,
    // Reading runs a command on another machine, which is an execution no
    // matter that the bytes it moves are ordinary.
    defaultReadTier: 'exec',
    async resolve(
      url: InternalUrl,
      _context?: ResolveContext,
    ): Promise<InternalResource> {
      const access = requireSsh(host, url);
      const known = await access.hosts();
      if (url.rest === '') {
        return {
          url: url.href,
          content: listSshHosts(known),
          contentType: 'text/markdown',
          isDirectory: true,
        };
      }
      const { target, remotePath } = parseSshTarget(url.rest, url);
      if (!known.some((host) => host.name === target.host)) {
        throw new Error(
          `${url.href}: no configured host is named '${target.host}'. Read \`ssh://\` for the ones that are configured.`,
        );
      }
      const quoted = posixQuote(remotePath);
      // One round trip: refuse a directory, then read one byte past the cap
      // so an oversized file is detected without downloading all of it.
      const command =
        `if [ -d ${quoted} ]; then echo 'ssh://: path is a directory' >&2; exit ${String(SSH_DIRECTORY_EXIT)}; fi; ` +
        `head -c ${String(SSH_TEXT_MAX_BYTES + 1)} ${quoted}`;
      const result = await runSsh(access, target, command, url);
      const where = `${remotePath} on ${target.host}`;
      if (result.exitCode === SSH_DIRECTORY_EXIT) {
        throw new Error(
          `${url.href}: ${where} is a directory. ssh:// reads one file; use the \`run\` tool for a directory listing.`,
        );
      }
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        throw new Error(
          `${url.href}: cannot read ${where}: ${detail === '' ? `ssh exited ${String(result.exitCode)}` : detail}`,
        );
      }
      const content = result.stdout;
      if (Buffer.byteLength(content) > SSH_TEXT_MAX_BYTES) {
        throw new Error(
          `${url.href}: ${where} is larger than the ${String(SSH_TEXT_MAX_BYTES)} byte ssh:// limit.`,
        );
      }
      if (content.includes('\u0000')) {
        throw new Error(
          `${url.href}: ${where} is not a UTF-8 text file (it contains NUL bytes).`,
        );
      }
      return {
        url: url.href,
        content,
        contentType: 'text/plain',
        size: Buffer.byteLength(content),
      };
    },
    promptDoc(): string {
      return '`ssh://<host>/<path>` — a UTF-8 text file (max 1 MiB) on one of your own SSH hosts; `ssh://` lists them.';
    },
  };
}

// --- wiring -----------------------------------------------------------------

/**
 * The user's own GitHub CLI, as a transport.
 *
 * `GhService.run` satisfies this interface as it stands, so the host hands
 * over an in-process `GhService` and nothing else — no bridge, no cache, no
 * second code path to `gh`. The argv, the payload narrowing, the filters and
 * the failure diagnosis all live in this file; the host only decides whether
 * `gh` is reachable at all.
 */
export interface ConflictGitHub {
  /** Run one `gh` invocation; a non-zero exit is reported, never thrown. */
  run(args: readonly string[], options: { cwd: string }): Promise<GhResult>;
}

/** One host the user's own ssh configuration resolves. */
export interface ConflictSshHost {
  /** The name `ssh://<name>/…` addresses, as an `~/.ssh/config` alias. */
  name: string;
  /** Address the alias expands to, when the configuration names one. */
  host?: string;
  /** User the configuration connects as. */
  username?: string;
  /** Port the configuration connects to, when it is not 22. */
  port?: number;
  /** Free-text note from the configuration. */
  description?: string;
}

/** Where one remote command runs. */
export interface ConflictSshTarget {
  host: string;
  /** Port from the URL, or `undefined` to let the ssh config decide. */
  port?: number;
}

/** Result of one remote command. A non-zero exit is reported, not thrown. */
export interface ConflictSshResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The user's own `ssh`, as a transport. The command is a POSIX snippet — the
 * remote's login shell parses it, so the caller quotes every path it
 * interpolates — and one `run` is one round trip, which is why the file read
 * is a single command rather than a stat followed by a fetch.
 */
export interface ConflictSsh {
  /** Hosts the user's ssh configuration resolves, for a bare `ssh://`. */
  hosts(): Promise<readonly ConflictSshHost[]>;
  /** Run one command on `target`; a non-zero exit is reported, not thrown. */
  run(target: ConflictSshTarget, command: string): Promise<ConflictSshResult>;
}

/**
 * Wiring the integrator supplies. Every accessor is a getter so a rebuilt host
 * is picked up on the next read; an accessor returning `undefined` means that
 * transport is unavailable, and the scheme says so rather than inventing a
 * document.
 */
export interface ConflictSchemeHost {
  /**
   * Registry of conflict ids for this session. Ids are what a `conflict://`
   * write addresses, so this must be the same registry the read path
   * registers into.
   */
  conflicts?: () => ConflictRegistry | undefined;
  /** GitHub access through the user's own `gh`, or `undefined` when off. */
  github?: () => ConflictGitHub | undefined;
  /** Remote file access through the user's own `ssh`, or `undefined`. */
  ssh?: () => ConflictSsh | undefined;
}

/** Every scheme in this file, in prompt order. */
export function conflictSchemeSpecs(host: ConflictSchemeHost): SchemeSpec[] {
  return [
    conflictScheme(host),
    githubScheme('pr', host),
    githubScheme('issue', host),
    sshScheme(host),
  ];
}
