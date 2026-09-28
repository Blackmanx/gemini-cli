/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A single step of a split-commit plan.
 *
 * `dependsOn` lists the {@link CommitStep.id} values that must be committed
 * before this one. It is optional: a step with no dependencies is a root of
 * the dependency graph.
 */
export interface CommitStep {
  /** Stable identifier, unique within a plan. */
  id: string;
  /** Human readable name shown to the user while reviewing the plan. */
  label: string;
  /** Repository-relative paths staged by this step. */
  files: string[];
  /** Ids of steps that must be applied first. */
  dependsOn?: string[];
}

/** Message used for every cycle, so callers can match on stable text. */
export const CIRCULAR_DEPENDENCY_ERROR =
  'Circular dependency detected in split commit plan.';

/**
 * Orders commit steps so that every step appears after the steps it depends
 * on.
 *
 * Ties are broken by the step's position in the input array, which makes the
 * output a pure function of its input: the same plan always produces the same
 * commit order, and reordering unrelated steps is a no-op.
 *
 * @throws Error if a step depends on an id that is not in `steps`, or if the
 * dependency graph contains a cycle.
 */
export function orderCommitSteps(steps: CommitStep[]): CommitStep[] {
  const total = steps.length;
  if (total === 0) {
    return [];
  }

  const indexById = new Map<string, number>();
  // dependents[i] are the indices of steps that depend on step i.
  const dependents: number[][] = Array.from({ length: total }, () => []);
  const inDegree = new Array<number>(total).fill(0);

  for (let index = 0; index < total; index++) {
    const step = steps[index];
    if (indexById.has(step.id)) {
      throw new Error(`Duplicate step id in split commit plan: ${step.id}`);
    }
    indexById.set(step.id, index);
  }

  for (let index = 0; index < total; index++) {
    const step = steps[index];
    const seenDependencies = new Set<string>();
    for (const dependencyId of step.dependsOn ?? []) {
      if (seenDependencies.has(dependencyId)) {
        continue;
      }
      seenDependencies.add(dependencyId);
      const dependencyIndex = indexById.get(dependencyId);
      if (dependencyIndex === undefined) {
        throw new Error(
          `Unknown step "${dependencyId}" referenced by "${step.id}" in split commit plan.`,
        );
      }
      if (dependencyIndex === index) {
        throw new Error(CIRCULAR_DEPENDENCY_ERROR);
      }
      dependents[dependencyIndex].push(index);
      inDegree[index] += 1;
    }
  }

  const ordered: CommitStep[] = [];
  const emitted = new Array<boolean>(total).fill(false);
  let remaining = total;

  // Kahn's algorithm, always taking the lowest ready index so the result is
  // stable regardless of how the edges were discovered.
  while (remaining > 0) {
    let current = -1;
    for (let index = 0; index < total; index++) {
      if (!emitted[index] && inDegree[index] === 0) {
        current = index;
        break;
      }
    }
    if (current === -1) {
      throw new Error(CIRCULAR_DEPENDENCY_ERROR);
    }
    emitted[current] = true;
    remaining -= 1;
    ordered.push(steps[current]);
    for (const dependent of dependents[current]) {
      inDegree[dependent] -= 1;
    }
  }

  return ordered;
}
