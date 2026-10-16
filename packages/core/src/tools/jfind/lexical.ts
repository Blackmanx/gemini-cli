/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lexical prior: per-file keyword occurrence counts from one bounded read
 * pass, turned into IDF weights and a file score that ranks candidates before
 * any judgment is spent.
 *
 * Ported from oh-my-pi's `tools/jfind/lexical.ts`; its native Rust grep is
 * replaced with a bounded Node read of the already-listed eligible files.
 */
import { countOccurrences, readText, ReadTextError } from './text.js';
import type { FileEntry } from './tree.js';

export interface GrepIndex {
  /** Lowercased, non-empty keywords; `perFileKw` vectors align with this. */
  keywords: string[];
  /** rel file path → per-keyword occurrence counts over matching lines. */
  perFileKw: Map<string, number[]>;
  /** Files the walk offered for scanning, including unreadable ones. */
  filesScanned: number;
}

/**
 * Bytes of each file fed to the lexical scan. Source files are overwhelmingly
 * smaller; the cap keeps one minified or generated file from dominating the
 * scan, and files this size are judged through their windows later anyway.
 */
const INDEX_READ_LIMIT = 512 * 1024;

/** Regex-escape a literal keyword for the scan alternation. */
function escapeRegex(keyword: string): string {
  return keyword.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, '\\$&');
}

export interface GrepIndexOptions {
  signal?: AbortSignal;
}

class ScanAbortedError extends Error {
  constructor() {
    super('The lexical scan was aborted');
    this.name = 'AbortError';
  }
}

/**
 * Count keyword occurrences (case-insensitive, any keyword) in every offered
 * file, keyed like `FileEntry.rel`. Only lines containing a keyword are
 * inspected, so counts are per matching line rather than per file byte.
 * Binary, blank, and unreadable files contribute no counts; the abort signal
 * stops the scan between files.
 */
export async function grepIndex(
  files: readonly FileEntry[],
  rawKeywords: readonly string[],
  options: GrepIndexOptions = {},
): Promise<GrepIndex> {
  const keywords = rawKeywords
    .map((keyword) => keyword.toLowerCase())
    .filter((keyword) => keyword.length > 0);
  const index: GrepIndex = {
    keywords,
    perFileKw: new Map(),
    filesScanned: files.length,
  };
  if (keywords.length === 0) return index;
  const anyKeyword = new RegExp(keywords.map(escapeRegex).join('|'));
  for (const file of files) {
    if (options.signal?.aborted) throw new ScanAbortedError();
    let text: string;
    try {
      text = (await readText(file.path, INDEX_READ_LIMIT)).text;
    } catch (error) {
      if (error instanceof ReadTextError) continue;
      throw error;
    }
    let counts: number[] | undefined;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.toLowerCase();
      if (!anyKeyword.test(line)) continue;
      counts ??= Array.from({ length: keywords.length }, () => 0);
      for (let k = 0; k < keywords.length; k++) {
        counts[k] += countOccurrences(line, keywords[k]);
      }
    }
    if (counts) index.perFileKw.set(file.rel, counts);
  }
  return index;
}

/**
 * Inverse document frequency per keyword, clamped to `[0.5, 6]`: rarity is
 * capped so a word occurring once in a test fixture cannot beat an
 * implementation that contains several query concepts repeatedly.
 */
export function idf(index: GrepIndex): number[] {
  return index.keywords.map((_, k) => {
    let df = 0;
    for (const counts of index.perFileKw.values()) {
      if ((counts[k] ?? 0) > 0) df++;
    }
    const weight = Math.log((index.filesScanned + 1) / (df + 1));
    return Math.min(6, Math.max(0.5, weight));
  });
}

/**
 * Lexical rank of a file: rare query terms count more, log-scaled frequency
 * keeps common words in a giant file from overwhelming a compact
 * implementation with several terms, and a keyword in the path is worth two
 * extra log-units.
 */
export function fileScore(
  counts: readonly number[],
  weights: readonly number[],
  rel: string,
  keywords: readonly string[],
): number {
  const lower = rel.toLowerCase();
  let score = 0;
  for (let k = 0; k < keywords.length; k++) {
    const inPath = lower.includes(keywords[k]) ? 1 : 0;
    score += weights[k] * (2 * inPath + Math.log1p(counts[k] ?? 0));
  }
  return score;
}

/**
 * Tool output, cache, and vendored trees: directories whose files repeat every
 * keyword of the query simply because they mirror the whole project.
 */
const GENERATED_DIR_RE =
  /(^|\/)[^/]+-out(\/|$)|(^|\/)(cache|caches|vendor|generated|third[_-]party|tmp|temp)(?=\/|$)/;

/** Prose and rendered reports: they describe the subject; they rarely implement it. */
const PROSE_EXT_RE = /\.(?:md|markdown|rst|adoc|html?|tex)$/i;

/**
 * Candidate-ranking weight for noise-heavy paths, in `[0.3, 1]`. Generated
 * dumps and prose stay searchable — a report can be the answer, and a name
 * judgment still decides — but they must not crowd the lexical shortlist the
 * way a generated mirror of the repository does. Applies only where
 * candidates are picked for judging, never to any judgment itself.
 */
export function candidatePenalty(rel: string): number {
  if (GENERATED_DIR_RE.test(rel)) return 0.3;
  if (PROSE_EXT_RE.test(rel)) return 0.5;
  return 1;
}
