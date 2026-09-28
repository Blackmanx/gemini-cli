/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { LOCK_FILE_MANIFESTS } from './lockFiles.js';

const HIGH_PRIORITY_EXTENSIONS: Readonly<Record<string, true>> = {
  '.rs': true,
  '.go': true,
  '.py': true,
  '.js': true,
  '.ts': true,
  '.tsx': true,
  '.jsx': true,
  '.java': true,
  '.c': true,
  '.cpp': true,
  '.h': true,
  '.hpp': true,
};

const SHELL_SQL_EXTENSIONS: Readonly<Record<string, true>> = {
  '.sh': true,
  '.bash': true,
  '.zsh': true,
  '.sql': true,
};

const MANIFEST_FILES: Readonly<Record<string, true>> = {
  'Cargo.toml': true,
  'package.json': true,
  'go.mod': true,
  'pyproject.toml': true,
  'requirements.txt': true,
  Gemfile: true,
  'build.gradle': true,
  'pom.xml': true,
};

const LOW_PRIORITY_EXTENSIONS: Readonly<Record<string, true>> = {
  '.md': true,
  '.txt': true,
  '.json': true,
  '.yaml': true,
  '.yml': true,
  '.toml': true,
  '.xml': true,
  '.csv': true,
};

const BINARY_EXTENSIONS: Readonly<Record<string, true>> = {
  '.png': true,
  '.jpg': true,
  '.jpeg': true,
  '.gif': true,
  '.ico': true,
  '.woff': true,
  '.woff2': true,
  '.ttf': true,
  '.eot': true,
  '.pdf': true,
  '.zip': true,
  '.tar': true,
  '.gz': true,
  '.exe': true,
  '.dll': true,
  '.so': true,
  '.dylib': true,
};

const TEST_PATTERNS: readonly string[] = [
  '/test/',
  '/tests/',
  '/__tests__/',
  '_test.',
  '.test.',
  '.spec.',
  '_spec.',
];

/** Final path segment of a repository-relative path. */
function basenameOf(filePath: string): string {
  const segments = filePath.split('/');
  return segments[segments.length - 1] ?? filePath;
}

/** Lowercase extension including the dot, or `''` when there is none. */
function extensionOf(basename: string): string {
  if (!basename.includes('.')) {
    return '';
  }
  return `.${basename.split('.').pop() ?? ''}`;
}

/**
 * Rank a changed file by how much it should drive the headline of a commit.
 *
 * Higher wins. The ordering is deliberate: implementation source (100) and
 * shell/SQL (80) outrank manifests (70), which outrank everything else
 * (50), which outranks tests (10) and data/config payloads (20), while
 * binaries sit at the bottom (-100) because a diff of them says nothing about
 * intent. A commit whose headline is a doc or a config blob is a commit nobody
 * can revert sensibly, so source files must never be sequenced behind them.
 */
export function getFilePriority(filePath: string): number {
  const basename = basenameOf(filePath);
  const ext = extensionOf(basename);

  if (BINARY_EXTENSIONS[ext] === true) {
    return -100;
  }

  const lowerPath = filePath.toLowerCase();
  for (const pattern of TEST_PATTERNS) {
    if (lowerPath.includes(pattern)) {
      return 10;
    }
  }

  if (
    LOW_PRIORITY_EXTENSIONS[ext] === true &&
    MANIFEST_FILES[basename] !== true
  ) {
    return 20;
  }
  if (MANIFEST_FILES[basename] === true) {
    return 70;
  }
  if (SHELL_SQL_EXTENSIONS[ext] === true) {
    return 80;
  }
  if (HIGH_PRIORITY_EXTENSIONS[ext] === true) {
    return 100;
  }

  return 50;
}

/**
 * Reports whether the final path segment of a repository-relative path is a
 * known lock file, i.e. a machine-generated resolution manifest that
 * {@link assignLockFilesToPlan} knows how to place.
 */
export function isLockFile(filePath: string): boolean {
  return LOCK_FILE_MANIFESTS[basenameOf(filePath)] !== undefined;
}
