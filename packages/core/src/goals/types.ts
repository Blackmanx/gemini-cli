/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Lifecycle state of a tracked goal. */
export type GoalStatus =
  | 'active'
  | 'paused'
  | 'budget-limited'
  | 'complete'
  | 'dropped';

/** Serializable goal progress and resource budget. */
export interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

/** Whether goal mode is engaged, and why it is leaving. */
export interface GoalModeState {
  enabled: boolean;
  mode: 'active' | 'exiting';
  reason?: 'completed';
  goal: Goal;
}

/** What the goal runtime tells the outside world. */
export type GoalRuntimeEvent =
  | { type: 'goal_updated'; goal: Goal | null; state?: GoalModeState }
  | { type: 'goal_continuation_requested'; prompt: string };

/**
 * Cumulative token usage the goal budget is measured against.
 *
 * There is no `cacheWrite` field, unlike upstream oh-my-pi. Gemini's
 * `usageMetadata` reports `cachedContentTokenCount` (cache reads) and has no
 * cache-creation counter, so a term here would be a number the backend never
 * fills in. The budget counts input and output only. Upstream needs the term
 * because Anthropic and Bedrock bill cache writes separately, where rotating
 * a large ephemeral cache can write 100K+ tokens.
 */
export interface GoalTokenUsage {
  input: number;
  output: number;
}

/** Statuses in which tokens and wall-clock keep accruing against the goal. */
const ACCOUNTS_TOWARD_BUDGET: Partial<Record<GoalStatus, true>> = {
  active: true,
  'budget-limited': true,
};

export function isAccountingStatus(status: GoalStatus): boolean {
  return ACCOUNTS_TOWARD_BUDGET[status] === true;
}

/**
 * What a session record keeps so a resumed session finds its goal again.
 *
 * `goal_paused` is distinct from `goal` on purpose: a goal the user paused
 * should come back paused, not silently start spending tokens again.
 */
export interface PersistedGoalState {
  mode: 'goal' | 'goal_paused';
  goal: Goal;
}
