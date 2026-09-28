/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Default maximum number of inline output lines. */
export const DEFAULT_MAX_LINES = 3000;
/** Default inline output budget in UTF-8 bytes. */
export const DEFAULT_MAX_BYTES = 50 * 1024;

const NL = '\n';

/** Structured accounting of a head truncation. */
export interface TruncationMeta {
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  emittedLines: number;
  emittedBytes: number;
  elidedLines: number;
  elidedBytes: number;
}

/** Head-truncated text plus its accounting. */
export interface TruncateHeadResult {
  text: string;
  meta: TruncationMeta;
}

function countNewlines(text: string): number {
  let count = 0;
  let pos = text.indexOf(NL);
  while (pos !== -1) {
    count++;
    pos = text.indexOf(NL, pos + 1);
  }
  return count;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

/**
 * Truncate `content` from the head, keeping whole lines only (the trailing
 * newline of the last kept line is dropped). Returns the head plus metadata
 * describing what was elided.
 */
export function truncateHead(
  content: string,
  opts: { maxLines?: number; maxBytes?: number } = {},
): TruncateHeadResult {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const totalBytes = byteLength(content);
  const totalLines = countNewlines(content) + 1;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      text: content,
      meta: {
        truncated: false,
        totalLines,
        totalBytes,
        emittedLines: totalLines,
        emittedBytes: totalBytes,
        elidedLines: 0,
        elidedBytes: 0,
      },
    };
  }

  let emittedLines = 0;
  let emittedBytes = 0;
  let cutIndex = 0; // char index where we cut (exclusive)
  let cursor = 0;

  while (emittedLines < maxLines) {
    const nl = content.indexOf(NL, cursor);
    const lineEnd = nl === -1 ? content.length : nl;
    const sepBytes = emittedLines > 0 ? 1 : 0;
    const remaining = maxBytes - emittedBytes - sepBytes;
    if (remaining < 0) break;

    // UTF-8 bytes >= UTF-16 code units, so oversized code units reject early.
    if (lineEnd - cursor > remaining) break;
    const lineText = content.slice(cursor, lineEnd);
    const lineBytes = byteLength(lineText);
    if (lineBytes > remaining) break;

    emittedBytes += sepBytes + lineBytes;
    emittedLines++;
    cutIndex = nl === -1 ? content.length : nl;
    if (nl === -1) break;
    cursor = nl + 1;
  }

  const text = content.slice(0, cutIndex);
  return {
    text,
    meta: {
      truncated: true,
      totalLines,
      totalBytes,
      emittedLines,
      emittedBytes: byteLength(text),
      elidedLines: Math.max(0, totalLines - emittedLines),
      elidedBytes: Math.max(0, totalBytes - byteLength(text)),
    },
  };
}

/** How many elided ranges a single footer will spell out. */
const FOOTER_RANGE_SAMPLES = 2;

/**
 * Footer telling the model how to recover the elided body of a read.
 *
 * Ported from omp (`tools/read-format.ts::formatSummaryElisionFooter`): the
 * ranges are drawn from the ACTUAL elision, so the model re-reads only the
 * spans it missed instead of falling back to a whole-file read.
 */
export function formatElisionFooter(
  elidedLines: number,
  elidedRanges: ReadonlyArray<{ start: number; end: number }>,
  readPath?: string,
): string {
  if (elidedRanges.length === 0) return '';
  const sampleCount = Math.min(elidedRanges.length, FOOTER_RANGE_SAMPLES);
  const selector = elidedRanges
    .slice(0, sampleCount)
    .map((r) => `${r.start}-${r.end}`)
    .join(',');
  if (readPath === undefined) {
    return `[…${elidedLines}ln elided; re-read needed ranges, e.g. :${selector}]`;
  }
  const example = `${readPath}:${selector}`;
  const tail =
    elidedRanges.length > sampleCount
      ? `, e.g. ${example}`
      : ` with ${example}`;
  return `[…${elidedLines}ln elided; re-read needed ranges${tail}]`;
}
