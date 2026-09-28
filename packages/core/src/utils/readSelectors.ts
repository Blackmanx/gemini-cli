/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inclusive line range describing one selector segment (e.g. `50-100`,
 * `301-`, or `50+10`). `endLine` is `undefined` for open-ended ranges.
 */
export interface LineRange {
  startLine: number;
  endLine: number | undefined;
}

/** Shared line-range grammar for selector recognition and parsing. */
export const LINE_RANGE_CHUNK_SOURCE = String.raw`L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?`;
const LINE_RANGE_CHUNK_RE = new RegExp(`^${LINE_RANGE_CHUNK_SOURCE}$`, 'i');

/**
 * Parse a single `N`, `N-M`, `N-`, `N+K`, or `..`-aliased (`N..M`, `N..`)
 * chunk. Returns `null` when the chunk is not line-shaped; throws on invalid
 * bounds.
 */
export function parseLineRangeChunk(sel: string): LineRange | null {
  return parseChunk(sel, false);
}

/** `pinBare` makes a separator-less `N` the single line `N` instead of "from `N` onward". */
function parseChunk(sel: string, pinBare: boolean): LineRange | null {
  const lineMatch = LINE_RANGE_CHUNK_RE.exec(sel);
  if (!lineMatch) return null;
  const rawStart = Number.parseInt(lineMatch[1], 10);
  if (rawStart < 1) {
    throw new Error('Line selector 0 is invalid; lines are 1-indexed. Use :1.');
  }
  // `..` is a forgiving alias for `-` (e.g. `2724..2727` == `2724-2727`).
  const sep = lineMatch[2] === '..' ? '-' : lineMatch[2];
  const rhs = lineMatch[3] ? Number.parseInt(lineMatch[3], 10) : undefined;
  let rawEnd: number | undefined;
  if (sep === '+') {
    if (rhs === undefined || rhs < 1) {
      throw new Error(
        `Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`,
      );
    }
    rawEnd = rawStart + rhs - 1;
  } else if (sep === '-') {
    // `301-` is shorthand for "from 301 onward" — equivalent to a lone bare `301`.
    if (rhs !== undefined) {
      if (rhs < rawStart) {
        throw new Error(
          `Invalid range ${rawStart}-${rhs}: end must be >= start.`,
        );
      }
      rawEnd = rhs;
    }
  } else if (pinBare) {
    rawEnd = rawStart;
  }
  return { startLine: rawStart, endLine: rawEnd };
}

/**
 * Parse a comma-separated list of line ranges (e.g. `5-16,960-973` or
 * `19,59`). Returns the ranges in ascending order with overlapping/adjacent
 * ranges merged so downstream consumers can stream the file in a single
 * forward pass per range.
 */
export function parseLineRanges(
  sel: string,
): [LineRange, ...LineRange[]] | null {
  const chunks = sel.split(',');
  // A lone `:50` means "from line 50". Inside a comma list, a bare number is
  // that one line; otherwise `:19,59` collapses to "from 19 through EOF".
  const pinBare = chunks.length > 1;
  const parsed: LineRange[] = [];
  for (const chunk of chunks) {
    const range = parseChunk(chunk, pinBare);
    if (!range) return null;
    parsed.push(range);
  }
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => a.startLine - b.startLine);

  const merged: LineRange[] = [parsed[0]];
  for (let i = 1; i < parsed.length; i++) {
    const current = parsed[i];
    const last = merged[merged.length - 1];
    // Open-ended (endLine undefined) means "to EOF" — any later range is absorbed.
    if (last.endLine === undefined) continue;
    // Merge when current starts within (or immediately after) the last range.
    if (current.startLine <= last.endLine + 1) {
      if (current.endLine === undefined || current.endLine > last.endLine) {
        merged[merged.length - 1] = {
          startLine: last.startLine,
          endLine: current.endLine,
        };
      }
      continue;
    }
    merged.push(current);
  }
  const [first, ...rest] = merged;
  if (first === undefined) return null;
  return [first, ...rest];
}

/**
 * Extract the line-range component from a read-tool selector that may also
 * carry a verbatim/index display mode (`raw`, `conflicts`) — alone or compounded
 * with a range (`raw:50-100`, `50-100:raw`). Returns the parsed ranges when the
 * selector names any, otherwise `undefined`.
 */
export function selectorLineRanges(
  sel: string | undefined,
): [LineRange, ...LineRange[]] | undefined {
  if (!sel) return undefined;
  for (const chunk of sel.split(':')) {
    const lower = chunk.toLowerCase();
    if (lower === 'raw' || lower === 'conflicts') continue;
    const ranges = parseLineRanges(chunk);
    if (ranges) return ranges;
  }
  return undefined;
}

/** Parsed representation of a path-embedded selector. */
export type ParsedSelector =
  | { kind: 'none' }
  | { kind: 'raw' }
  | { kind: 'conflicts' }
  | { kind: 'image' }
  | { kind: 'lines'; ranges: [LineRange, ...LineRange[]]; raw?: boolean }
  /** `:-N` — the last N lines. Needs the source's line count before it can be sliced. */
  | { kind: 'tail'; count: number; raw?: boolean };

/**
 * A selector whose bounds are absolute — every kind except `tail`.
 */
export type ResolvedSelector = Exclude<ParsedSelector, { kind: 'tail' }>;

/** Returns true when the selector requested verbatim/raw output. */
export function isRawSelector(parsed: ParsedSelector): boolean {
  return (
    parsed.kind === 'raw' ||
    ((parsed.kind === 'lines' || parsed.kind === 'tail') && parsed.raw === true)
  );
}

/** Returns true when the selector requested multiple line ranges. */
export function isMultiRange(parsed: ParsedSelector): boolean {
  return parsed.kind === 'lines' && parsed.ranges.length > 1;
}

const TAIL_SELECTOR_RE = /^-(\d+)$/;

/** Parse a `-N` tail selector into its line count (`:-60` → 60 last lines). */
function parseTailCount(sel: string): number | null {
  const match = TAIL_SELECTOR_RE.exec(sel);
  if (!match) return null;
  const count = Number.parseInt(match[1], 10);
  if (count < 1) {
    throw new Error(
      'Tail selector -0 is invalid; use :-N with N >= 1 to read the last N lines.',
    );
  }
  return count;
}

/**
 * Pin a `:-N` tail selector to absolute lines against a source of
 * `totalLines` lines; every other selector passes through unchanged.
 */
export function resolveTailSelector(
  parsed: ParsedSelector,
  totalLines: number,
): ResolvedSelector {
  if (parsed.kind !== 'tail') return parsed;
  const startLine = Math.max(1, totalLines - parsed.count + 1);
  return {
    kind: 'lines',
    ranges: [{ startLine, endLine: Math.max(startLine, totalLines) }],
    raw: parsed.raw,
  };
}

function selectorChunkLooksReadLike(chunk: string): boolean {
  const lower = chunk.toLowerCase();
  return (
    lower === 'raw' ||
    lower === 'conflicts' ||
    lower === 'img' ||
    /^-\d+(?:[-+]\d+)?$/.test(chunk) ||
    parseLineRanges(chunk) !== null
  );
}

function invalidSelector(sel: string): Error {
  return new Error(
    `Invalid selector ':${sel}'. Use :N, :N-M, :N+K, :N- (open-ended), :-N (last N lines), a comma-separated list of ranges, :raw, :img for SVG rendering, or a range combined with raw (e.g. :raw:50-100).`,
  );
}

/** Parse a bare (non-compound) chunk as a line-range list or a tail count. */
function parseRangeOrTail(chunk: string, raw: boolean): ParsedSelector | null {
  const ranges = parseLineRanges(chunk);
  if (ranges)
    return raw ? { kind: 'lines', ranges, raw } : { kind: 'lines', ranges };
  const count = parseTailCount(chunk);
  if (count !== null) {
    return raw ? { kind: 'tail', count, raw } : { kind: 'tail', count };
  }
  return null;
}

/** The error text omp produces for a malformed read selector. */
export function describeSelectorForError(sel: string): string {
  return invalidSelector(sel).message;
}

/** Parse a read-tool path selector (e.g. `1-50`, `raw:50-100`, `:-60`). */
export function parseSel(sel: string | undefined): ParsedSelector {
  if (!sel || sel.length === 0) return { kind: 'none' };

  // Compound selector: `1-50:raw`, `raw:1-50`, or `raw:-60`. Split into chunks
  // and accept exactly one line range (possibly multi) or tail plus the literal
  // `raw`. Selector-like compounds that are not in that accepted set are invalid
  // rather than "none"; otherwise `read` can silently widen a malformed selector
  // while `grep` rejects it.
  if (sel.includes(':')) {
    const chunks = sel.split(':');
    if (chunks.length === 2) {
      const a = chunks[0];
      const b = chunks[1];
      const aIsRaw = a.toLowerCase() === 'raw';
      const bIsRaw = b.toLowerCase() === 'raw';
      const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
      const rawChunk = aIsRaw ? a : bIsRaw ? b : null;
      if (rangeChunk !== null && rawChunk !== null) {
        const parsed = parseRangeOrTail(rangeChunk, true);
        if (parsed) return parsed;
      }
    }
    if (chunks.every(selectorChunkLooksReadLike)) throw invalidSelector(sel);
    // Unrecognized compound — fall through (sqlite/archive/url consume their own colon syntax).
    return { kind: 'none' };
  }

  if (sel.toLowerCase() === 'raw') return { kind: 'raw' };
  if (sel.toLowerCase() === 'conflicts') return { kind: 'conflicts' };
  if (sel.toLowerCase() === 'img') return { kind: 'image' };
  const parsed = parseRangeOrTail(sel, false);
  if (parsed) return parsed;
  // Unrecognized selectors fall through; sqlite/archive/url readers consume their own colon syntax.
  return { kind: 'none' };
}

/**
 * Convert a single-range selector to the offset/limit pair used by internal
 * pagination. Returns the FIRST range only — multi-range callers MUST branch on
 * {@link isMultiRange} before calling this helper.
 */
export function selToOffsetLimit(parsed: ResolvedSelector): {
  offset?: number;
  limit?: number;
} {
  if (parsed.kind === 'lines') {
    const first = parsed.ranges[0];
    const limit =
      first.endLine !== undefined
        ? first.endLine - first.startLine + 1
        : undefined;
    return { offset: first.startLine, limit };
  }
  return {};
}

/**
 * Return the exact selected lines of `content` (1-indexed, inclusive) joined
 * by `\n`. No context lines are added.
 */
export function sliceLinesForSelector(
  content: string,
  parsed: ResolvedSelector,
): string {
  if (parsed.kind !== 'lines') return content;
  const lines = content.split('\n');
  // A trailing newline yields a final empty element that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const out: string[] = [];
  for (const range of parsed.ranges) {
    const end = range.endLine === undefined ? lines.length : range.endLine;
    for (let n = range.startLine; n <= end; n++) {
      const line = lines[n - 1];
      if (line !== undefined) out.push(line);
    }
  }
  return out.join('\n');
}

/**
 * Split a tool path into its path part and its trailing line selector.
 *
 * The selector grammar is ambiguous on purpose: `db.sqlite:table` and
 * `bundle.zip:src/a.ts` are NOT selectors, they are container syntax that
 * other readers own. A colon suffix is therefore only peeled off when
 * `parseSel` recognises it, and a Windows drive letter (`C:\...`) is never
 * treated as a selector boundary.
 *
 * An unrecognised-but-selector-shaped suffix is a hard error rather than a
 * silent full read, so a malformed selector cannot quietly widen a read.
 */
export function splitPathAndSelector(input: string): {
  path: string;
  selector: ParsedSelector;
  selectorText: string | undefined;
} {
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i] !== ':') continue;
    // Never split on a Windows drive letter: `C:\foo` / `c:foo`.
    if (i === 1 && /[A-Za-z]/.test(input[0])) continue;
    const suffix = input.slice(i + 1);
    if (suffix.length === 0) continue;
    // A line selector never contains a path separator, so a colon that does
    // is container syntax owned by another reader (db.sqlite:table, a.zip:b).
    if (suffix.includes('/') || suffix.includes('\\')) continue;
    // `parseSel` throws for a selector-shaped suffix it cannot parse, so a
    // malformed selector surfaces as an error instead of silently widening
    // the read to the whole file.
    const parsed = parseSel(suffix);
    if (parsed.kind !== 'none') {
      return {
        path: input.slice(0, i),
        selector: parsed,
        selectorText: suffix,
      };
    }
  }
  return { path: input, selector: { kind: 'none' }, selectorText: undefined };
}
