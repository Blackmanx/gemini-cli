/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';

const GLOB_PATH_CHARS = ['*', '?', '[', '{'] as const;

/** Result of splitting a user-supplied find pattern into a search root plus a glob. */
export interface ParsedFindPattern {
  /** Directory the search runs in, relative to the start dir (`''` for the start dir). */
  base: string;
  /** Glob pattern matched relative to `base`. */
  pattern: string;
}

/** True when the input contains any glob metacharacter. */
export function hasGlobChars(pattern: string): boolean {
  return GLOB_PATH_CHARS.some((char) => pattern.includes(char));
}

function firstGlobSegment(segments: readonly string[]): number {
  for (let i = 0; i < segments.length; i++) {
    if (hasGlobChars(segments[i])) return i;
  }
  return -1;
}

/** Express `base` relative to `startDir`; keeps bases outside `startDir` verbatim. */
function relativize(base: string, startDir: string | undefined): string {
  if (!startDir) return base === '.' ? '' : base;
  const root = path.resolve(startDir);
  const abs = path.isAbsolute(base)
    ? path.resolve(base)
    : path.resolve(root, base);
  const rel = path.relative(root, abs);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return base;
  return rel;
}

/**
 * Split a find pattern into a base directory plus a glob pattern, giving omp's
 * find-style implicit recursion.
 *
 * Examples (starstar is the recursive wildcard):
 *   `src/app/starstar/x.tsx` -> `{ base: 'src/app', pattern: 'starstar/x.tsx' }`
 *   `x.ts`                   -> `{ base: '', pattern: 'starstar/x.ts' }`
 *   `src/app`                -> `{ base: 'src/app', pattern: 'starstar-slash-all' }`
 *
 * A pattern with no metacharacters still recurses, so a bare leaf name matches at
 * any depth. Glob characters in the first segment anchor the search at the start
 * dir and are prefixed with the recursive wildcard; later glob characters split
 * the leading literal segments off as the base.
 */
export function parseFindPattern(
  pattern: string,
  startDir?: string,
): ParsedFindPattern {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    throw new Error('Pattern must not be empty.');
  }
  if (trimmed === '/') {
    throw new Error('Pattern must not be the filesystem root "/".');
  }

  const normalized = trimmed.replace(/\\/g, '/');
  const stripped =
    normalized.endsWith('/') && normalized !== '/'
      ? normalized.slice(0, -1)
      : normalized;
  const segments = stripped.split('/');
  const firstGlobIndex = firstGlobSegment(segments);

  if (firstGlobIndex === -1) {
    // No glob characters. If the whole thing names an existing FILE it is a
    // literal, and the search must be rooted at its DIRECTORY: treating
    // `notes.md` as a base and searching `**/*` inside it looks for a
    // directory called `notes.md`, finds nothing, and reports "no files
    // found" for a file that is right there.
    const asFile = path.resolve(startDir ?? process.cwd(), stripped);
    if (existsSync(asFile) && statSync(asFile).isFile()) {
      return {
        base: relativize(path.dirname(asFile), startDir),
        pattern: path.basename(asFile),
      };
    }
    return { base: relativize(stripped, startDir), pattern: '**/*' };
  }

  if (firstGlobIndex === 0) {
    const needsRecursive = !stripped.startsWith('**/');
    return {
      base: relativize('.', startDir),
      pattern: needsRecursive ? `**/${stripped}` : stripped,
    };
  }

  return {
    base: relativize(segments.slice(0, firstGlobIndex).join('/'), startDir),
    pattern: segments.slice(firstGlobIndex).join('/'),
  };
}
