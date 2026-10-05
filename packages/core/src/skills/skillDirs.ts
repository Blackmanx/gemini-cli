/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Where a `.agents/skills` directory lives, and how many are in play.
 *
 * A workspace root is rarely the place the skills are written. In a repo laid
 * out as `workspace/{service-a,service-b}`, each service owns its own
 * `.agents/skills`, and the person who wants all of them is standing in
 * `workspace`, not inside either service. Resolving only `<cwd>/.agents/skills`
 * answers "none" there, which reads as "this project has no skills" rather than
 * "you are one level above them".
 */

/** How far below the starting directory the scan goes. */
const MAX_DESCENDANT_DEPTH = 3;

/**
 * Directories that never hold a team's own skills and are expensive to walk.
 * `node_modules` and `.git` are the large ones; the rest are build output that
 * would otherwise contribute stale copies of a skill.
 */
const SKIPPED_DIRS: Record<string, true> = {
  '.git': true,
  node_modules: true,
  bower_components: true,
  vendor: true,
  dist: true,
  build: true,
  out: true,
  target: true,
  coverage: true,
  '.next': true,
  '.nuxt': true,
  '.turbo': true,
  '.cache': true,
  '.venv': true,
  venv: true,
  __pycache__: true,
};

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function exists(candidate: string): boolean {
  try {
    fs.statSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every `.agents/skills` directory reachable from `startDir`: the one beside
 * it, plus those belonging to nested projects below it.
 *
 * A directory holding a `.git` is treated as a project boundary. Its own
 * `.agents/skills` is collected, and the scan stops there rather than walking
 * into the project's subpackages — otherwise a service's vendored copy would
 * shadow the real one. A root with no `.git` anywhere below it is walked to the
 * depth limit, which is what makes a plain folder of sibling repos work.
 */
export function findProjectAgentSkillDirs(startDir: string): string[] {
  const root = path.resolve(startDir);
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const skillsDir = path.join(current.dir, '.agents', 'skills');
    if (isDirectory(skillsDir)) {
      found.push(skillsDir);
    }

    // The root is where the user chose to be, so a repo boundary there still
    // gets walked past — they may be standing in a service and mean its
    // subpackages' skills. Everywhere else, `.git` ends the descent.
    if (current.depth > 0 && exists(path.join(current.dir, '.git'))) {
      continue;
    }
    if (current.depth >= MAX_DESCENDANT_DEPTH) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIPPED_DIRS[entry.name]) continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  return found;
}