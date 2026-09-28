/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A rule file found in a foreign agent's configuration directory, normalised
 * into the shape prompt assembly consumes.
 *
 * `alwaysApply` is the load-bearing field: only rules that a foreign tool would
 * itself inject on every request belong in the always-apply tier, and inlining
 * a glob-scoped rule would flood the prompt with guidance for files that are
 * not being touched.
 */
export interface DiscoveredRule {
  /** Identity used for first-wins dedup across providers. */
  name: string;
  /** Absolute path of the file the rule was read from. */
  path: string;
  /** File body with any frontmatter block stripped. */
  content: string;
  /** File globs the rule is scoped to; empty when unscoped. */
  globs: string[];
  /** Whether the foreign tool would inline this rule on every request. */
  alwaysApply: boolean;
  /** Short label for the rulebook listing. */
  description?: string;
  /** Which importer produced it, e.g. 'cursor', 'github', 'cline'. */
  source: string;
  /** Stable id for suppression, e.g. `rule:cursor:my-rule`. */
  id: string;
}

/**
 * An importer that contributes discovered rules for a target directory.
 */
export interface DiscoveryProvider {
  /** Stable provider id, also used as the `source` of its rules. */
  id: string;
  displayName: string;
  /** Higher wins when two providers claim the same rule name. */
  priority: number;
  load(targetDir: string): Promise<DiscoveredRule[]>;
}

/**
 * Outcome of a discovery run.
 */
export interface DiscoveryResult {
  /** Deduplicated rules, highest-priority provider first. */
  rules: DiscoveredRule[];
  /**
   * Human-readable notes rather than a thrown error: a provider that failed, a
   * file that could not be parsed, a lower-priority rule that lost its name.
   */
  notes: string[];
}
