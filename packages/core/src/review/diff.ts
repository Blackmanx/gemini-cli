/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getSafeGitEnv } from '../utils/gitUtils.js';

const execFileAsync = promisify(execFile);

/**
 * What is under review, gathered from git.
 *
 * Ported from omp's `review/diff.ts`. The point of freezing the diff up front
 * is that a review must be of ONE state of the tree. If the reviewer keeps
 * re-running git while the agent is still editing, the findings describe a
 * file that no longer exists.
 */

/** Above this, the diff is summarised rather than pasted whole. */
export const MAX_DIFF_CHARS = 50_000;

/** Above this many files, per-file previews replace the full diff. */
export const MAX_DIFF_FILES = 20;

/** Roughly how much of each file to show once the full diff is dropped. */
const PER_FILE_PREVIEW_LINES = 60;

export interface ReviewTarget {
  /** The unified diff, or a summary when it was too large to inline. */
  diff: string;
  /** Files the diff touches. */
  files: string[];
  /** True when the full diff was dropped in favour of per-file previews. */
  summarised: boolean;
  /** What the diff describes, e.g. `working tree` or `HEAD~1..HEAD`. */
  source: string;
  error?: string;
}

async function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, ...getSafeGitEnv() },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/**
 * Files the working tree has changes in, uncommitted included.
 *
 * Untracked files are listed too. `git diff HEAD` does not see them, and a
 * new file is very often the most important thing in a change to review —
 * omitting them would make the review confidently wrong.
 */
async function changedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await git(['diff', '--name-only', 'HEAD'], cwd);
  const tracked = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  let untracked: string[] = [];
  try {
    const listed = await git(
      ['ls-files', '--others', '--exclude-standard'],
      cwd,
    );
    untracked = listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    // A repository with no index yet has no untracked list; that is fine.
    untracked = [];
  }
  return [...new Set([...tracked, ...untracked])].sort();
}

/** A synthetic diff for a file git does not track yet. */
async function untrackedFileDiff(cwd: string, file: string): Promise<string> {
  try {
    const content = await fsPromises.readFile(path.join(cwd, file), 'utf8');
    const body = content
      .split('\n')
      .map((line) => `+${line}`)
      .join('\n');
    return `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${content.split('\n').length} @@\n${body}\n`;
  } catch {
    return `--- /dev/null\n+++ b/${file}\n(new untracked file, content not readable)\n`;
  }
}

/**
 * Freeze the current working-tree diff for review.
 *
 * Uncommitted changes are the common case, and reviewing what is about to be
 * committed is the moment a review is worth having.
 */
export async function collectReviewTarget(cwd: string): Promise<ReviewTarget> {
  if (!(await isRepo(cwd))) {
    return {
      diff: '',
      files: [],
      summarised: false,
      source: 'working tree',
      error: 'Not a git repository, so there is nothing to review.',
    };
  }
  try {
    const files = await changedFiles(cwd);
    if (files.length === 0) {
      return {
        diff: '',
        files: [],
        summarised: false,
        source: 'working tree',
        error: 'No uncommitted changes to review.',
      };
    }
    let { stdout } = await git(['diff', '--no-color', 'HEAD'], cwd);
    const untracked = files.filter((file) => !stdout.includes(`b/${file}`));
    for (const file of untracked) {
      stdout += await untrackedFileDiff(cwd, file);
    }
    if (stdout.length <= MAX_DIFF_CHARS && files.length <= MAX_DIFF_FILES) {
      return { diff: stdout, files, summarised: false, source: 'working tree' };
    }
    return {
      diff: await summariseLargeDiff(cwd, files),
      files,
      summarised: true,
      source: 'working tree',
    };
  } catch (err) {
    return {
      diff: '',
      files: [],
      summarised: false,
      source: 'working tree',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function isRepo(cwd: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--git-dir'], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * A diff too large to send whole.
 *
 * Each file gets the first `PER_FILE_PREVIEW_LINES` of its own diff. The
 * reviewer is told explicitly that this is a summary and must not re-run git,
 * because re-running it would defeat the freeze the whole review rests on.
 */
async function summariseLargeDiff(
  cwd: string,
  files: string[],
): Promise<string> {
  const parts: string[] = [];
  for (const file of files.slice(0, MAX_DIFF_FILES)) {
    let chunk = '';
    try {
      const { stdout } = await git(
        ['diff', '--no-color', 'HEAD', '--', file],
        cwd,
      );
      chunk = stdout.split('\n').slice(0, PER_FILE_PREVIEW_LINES).join('\n');
    } catch {
      chunk = '(could not read this file)';
    }
    parts.push(
      `--- ${file} (first ${PER_FILE_PREVIEW_LINES} lines) ---\n${chunk}`,
    );
  }
  if (files.length > MAX_DIFF_FILES) {
    parts.push(`…and ${files.length - MAX_DIFF_FILES} more files.`);
  }
  return parts.join('\n\n');
}

/**
 * How many reviewer subagents this diff warrants.
 *
 * Ported from omp's `getRecommendedReviewAgentCount`: a small diff does not
 * benefit from being split, and the fan-out costs more than it returns.
 */
export function getRecommendedReviewAgentCount(
  changedLineCount: number,
  fileCount: number,
): number {
  if (changedLineCount < 100 || fileCount <= 2) return 1;
  if (fileCount <= 6) return 2;
  if (fileCount <= 15) return 3;
  return 4;
}

/** Count the changed lines in a unified diff. */
export function countChangedLines(diff: string): number {
  let count = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) count += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) count += 1;
  }
  return count;
}
