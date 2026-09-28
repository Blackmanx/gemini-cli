/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommitStep } from './topoSort.js';

/**
 * Lock-file basename -> ordered sibling manifests. Order matters: the first
 * manifest present in the plan wins, so multi-manifest lock files
 * (`gradle.lockfile`) resolve deterministically.
 */
export const LOCK_FILE_MANIFESTS: Readonly<Record<string, readonly string[]>> =
  {
    'Cargo.lock': ['Cargo.toml'],
    'package-lock.json': ['package.json'],
    'yarn.lock': ['package.json'],
    'pnpm-lock.yaml': ['package.json'],
    'bun.lock': ['package.json'],
    'bun.lockb': ['package.json'],
    'go.sum': ['go.mod'],
    'poetry.lock': ['pyproject.toml'],
    'Pipfile.lock': ['Pipfile'],
    'uv.lock': ['pyproject.toml'],
    'composer.lock': ['composer.json'],
    'Gemfile.lock': ['Gemfile'],
    'flake.lock': ['flake.nix'],
    'pubspec.lock': ['pubspec.yaml'],
    'Podfile.lock': ['Podfile'],
    'mix.lock': ['mix.exs'],
    'gradle.lockfile': [
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
    ],
  };

/** Split a repository-relative path into its directory and basename. */
function splitPath(filePath: string): { dir: string; basename: string } {
  const segments = filePath.split('/');
  const basename = segments.pop() ?? filePath;
  return { dir: segments.join('/'), basename };
}

/** Index of the first step staging a file with one of `basenames`, else -1. */
function findStepByBasename(
  steps: CommitStep[],
  basenames: readonly string[],
): number {
  for (const basename of basenames) {
    for (let index = 0; index < steps.length; index++) {
      const staged = steps[index].files.some(
        (file) => splitPath(file).basename === basename,
      );
      if (staged) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Resolve the step a lock file belongs to, following the precedence documented
 * on {@link assignLockFilesToPlan}.
 */
function resolveStepIndex(
  plan: CommitStep[],
  dir: string,
  manifests: readonly string[],
  filesByDir: Map<string, string[]>,
): number {
  const siblingFiles = filesByDir.get(dir) ?? [];
  const siblingManifests = manifests.filter((manifest) => {
    for (const file of siblingFiles) {
      if (splitPath(file).basename === manifest) {
        return true;
      }
    }
    return false;
  });

  const siblingIndex = findStepByBasename(plan, siblingManifests);
  if (siblingIndex !== -1) {
    return siblingIndex;
  }
  const manifestIndex = findStepByBasename(plan, manifests);
  if (manifestIndex !== -1) {
    return manifestIndex;
  }
  return plan.length - 1;
}

/**
 * Attach lock files to a split-commit plan.
 *
 * The commit agent hides machine-generated files from analysis so the model
 * neither wastes tokens on them nor treats them as evidence for commit
 * boundaries. That leaves them changed but unplanned, and an executor that
 * replayed the plan would silently drop them. Placement is therefore decided
 * here, by rule rather than by the model, because a lock file in a commit
 * nobody planned is a change the user cannot audit.
 *
 * Precedence for each lock file:
 *   1. the first step that stages a sibling manifest in the same directory —
 *      the strongest signal, e.g. a workspace crate's `Cargo.toml` sitting
 *      next to its `Cargo.lock`;
 *   2. the first step that stages a sibling manifest anywhere, because a
 *      monorepo may lock at the repository root while the manifest lives
 *      under a subpath;
 *   3. the last step, so the file still ships.
 *
 * Ties inside a precedence level resolve by step order, then by the manifest
 * order in {@link LOCK_FILE_MANIFESTS}, so the result depends only on its
 * inputs.
 *
 * @param lockFiles Lock files to place, in caller order. A file already staged
 *   by some step stays where it is.
 * @param steps The plan to extend. Never mutated, and `files` arrays are never
 *   aliased between input and output.
 * @param filesByDir Index of directory -> changed files in the working tree.
 *   It is only a lookup aid: a missing entry falls back to the steps' own file
 *   lists, so an incomplete index can never drop a file.
 * @returns A new array of new steps.
 */
export function assignLockFilesToPlan(
  lockFiles: string[],
  steps: CommitStep[],
  filesByDir: Map<string, string[]>,
): CommitStep[] {
  const plan: CommitStep[] = steps.map((step) => ({
    ...step,
    files: [...step.files],
  }));
  if (plan.length === 0) {
    return plan;
  }

  const staged = new Set(plan.flatMap((step) => step.files));
  for (const lockFile of lockFiles) {
    if (staged.has(lockFile)) {
      continue;
    }
    const { dir, basename } = splitPath(lockFile);
    const targetIndex = resolveStepIndex(
      plan,
      dir,
      LOCK_FILE_MANIFESTS[basename] ?? [],
      filesByDir,
    );
    plan[targetIndex].files.push(lockFile);
    staged.add(lockFile);
  }

  return plan;
}
