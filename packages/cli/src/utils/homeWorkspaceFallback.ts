/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveToRealPath } from '@google/gemini-cli-core';

/** Compare paths the way omp does: realpath-resolved, case-folded on win32. */
function normalizePath(p: string): string {
  try {
    return resolveToRealPath(p);
  } catch {
    return path.resolve(p);
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The CLI derives its workspace root from the current directory, so being
 * launched from $HOME would make it treat the whole home directory as the
 * project. Mirror omp: switch to the first existing temp dir instead.
 *
 * Returns the directory the process moved to, or undefined when the cwd was
 * already a real workspace (or no candidate was usable).
 */
export function redirectHomeWorkspaceToTmp(
  home: string = os.homedir(),
  tmpDir: string = os.tmpdir(),
): string | undefined {
  if (!home) {
    return undefined;
  }

  const cwd = normalizePath(process.cwd());
  if (cwd !== normalizePath(home)) {
    return undefined;
  }

  const candidates =
    process.platform === 'win32'
      ? [path.join(home, 'tmp')]
      : [path.join(home, 'tmp'), '/tmp', '/var/tmp'];

  for (const candidate of candidates) {
    if (isDirectory(candidate)) {
      process.chdir(candidate);
      return candidate;
    }
  }

  if (tmpDir && normalizePath(tmpDir) !== cwd && isDirectory(tmpDir)) {
    process.chdir(tmpDir);
    return tmpDir;
  }
  return undefined;
}
