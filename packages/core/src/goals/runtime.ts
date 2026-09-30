/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { debugLogger } from '../utils/debugLogger.js';
import {
  type Goal,
  type GoalModeState,
  type GoalRuntimeEvent,
  type GoalTokenUsage,
  isAccountingStatus,
} from './types.js';

/**
 * Everything the runtime needs from its host.
 *
 * Smaller than oh-my-pi's `GoalRuntimeHost` on purpose: that one had
 * `sendHiddenMessage` with a three-way `deliverAs`, which this fork has no
 * equivalent for. Budget steering is an injection, so that is what this asks
 * for.
 */
export interface GoalRuntimeHost {
  getState(): GoalModeState | undefined;
  setState(state: GoalModeState | undefined): void;
  /** Cumulative session usage, monotonic across turns. */
  getCurrentUsage(): GoalTokenUsage;
  emit(event: GoalRuntimeEvent): void;
  /** Make the goal durable so it survives a session resume. */
  persist(mode: 'goal' | 'goal_paused' | 'none', state?: GoalModeState): void;
  /** Deliver a message into the running turn. */
  sendSteerMessage(text: string): void;
  now?(): number;
}

interface TurnSnapshot {
  turnId: string;
  baselineUsage: GoalTokenUsage;
  goalId?: string;
}

interface WallClockSnapshot {
  lastAccountedAt: number;
  goalId?: string;
}

/** Token usage attributed to a goal since the last baseline. */
export function goalTokenDelta(
  current: GoalTokenUsage,
  baseline: GoalTokenUsage,
): number {
  // cacheRead is excluded: it is reused prefix, not new work consumed by the
  // goal. Upstream also adds cacheWrite, which this fork has no counter for.
  return (
    Math.max(0, current.input - baseline.input) +
    Math.max(0, current.output - baseline.output)
  );
}

export function remainingTokens(goal: Goal | null | undefined): number | null {
  if (!goal || goal.tokenBudget === undefined) return null;
  return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

function budgetValue(goal: Goal): string {
  return goal.tokenBudget === undefined ? 'none' : String(goal.tokenBudget);
}

function remainingValue(goal: Goal): string {
  return goal.tokenBudget === undefined
    ? 'unbounded'
    : String(Math.max(0, goal.tokenBudget - goal.tokensUsed));
}

/**
 * Wraps the objective in tags and escapes the closing tag, so an objective
 * that itself contains `</objective>` cannot end the block early and have the
 * rest read as instructions.
 */
export function renderTrustedObjective(objective: string): string {
  return `<objective>\n${objective.replaceAll('</objective>', '&lt;/objective&gt;')}\n</objective>`;
}

export type GoalPromptKind = 'active' | 'continuation' | 'budget-limit';

export function renderGoalPrompt(kind: GoalPromptKind, goal: Goal): string {
  const variables: Record<string, string> = {
    objective: goal.objective.replaceAll('</objective>', '&lt;/objective&gt;'),
    tokensUsed: String(goal.tokensUsed),
    tokenBudget: budgetValue(goal),
    remainingTokens: remainingValue(goal),
    timeUsedSeconds: String(goal.timeUsedSeconds),
  };
  const fill = (text: string) =>
    text.replace(
      /\{\{(\w+)\}\}/g,
      (match, key: string) => variables[key] ?? match,
    );

  switch (kind) {
    case 'active':
      return fill(
        `A goal is active for this session. Work toward it until it is met, the budget runs out, or the work is genuinely blocked.

{{objective}}

Tokens used: {{tokensUsed}} of {{tokenBudget}} ({{remainingTokens}} remaining).
Time used: {{timeUsedSeconds}} seconds.

Call the goal tool with op=complete when the objective is met, or op=drop if it should be abandoned. If you stop for any other reason, say what is blocking you.`,
      );
    case 'continuation':
      return fill(
        `Continue working on the active goal. You stopped without completing it.

{{objective}}

Tokens used: {{tokensUsed}} of {{tokenBudget}} ({{remainingTokens}} remaining).
Time used: {{timeUsedSeconds}} seconds.

Carry on from where you left off, or use the goal tool to complete or drop the goal.`,
      );
    case 'budget-limit':
      return fill(
        `The goal's token budget is exhausted. Stop making tool calls that cost tokens and wrap up now.

{{objective}}

Tokens used: {{tokensUsed}} of {{tokenBudget}}.
Time used: {{timeUsedSeconds}} seconds.

Report what was achieved, what was not, and what remains. Then use the goal tool with op=complete if the objective was met despite the budget, or op=drop if it should be abandoned.`,
      );
    default:
      throw new Error(`unknown goal prompt kind: ${kind satisfies never}`);
  }
}

export function completionBudgetReport(goal: Goal): string | null {
  const parts: string[] = [];
  if (goal.tokenBudget !== undefined) {
    parts.push(`tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}`);
  }
  if (goal.timeUsedSeconds > 0) {
    parts.push(`time used: ${goal.timeUsedSeconds} seconds`);
  }
  if (parts.length === 0) return null;
  return `Goal achieved. Report final budget usage to the user: ${parts.join('; ')}.`;
}

export function validateTokenBudget(tokenBudget: number | undefined): void {
  if (
    tokenBudget !== undefined &&
    (!Number.isInteger(tokenBudget) || tokenBudget <= 0)
  ) {
    throw new Error('token_budget must be a positive integer when provided');
  }
}

function cloneGoal(goal: Goal): Goal {
  return { ...goal };
}

function cloneState(state: GoalModeState): GoalModeState {
  return { ...state, goal: cloneGoal(state.goal) };
}

/**
 * Tracks one goal: its lifecycle, its token and wall-clock spend, and what the
 * host has to be told about it.
 *
 * Accounting is delta-based. The host hands over cumulative session usage and
 * the runtime keeps a baseline per turn, so usage is attributed to the goal
 * only for the turns that ran while it was active.
 */
export class GoalRuntime {
  private readonly host: GoalRuntimeHost;
  private readonly emitter = new EventEmitter();
  private turnSnapshot: TurnSnapshot | undefined;
  private wallClock: WallClockSnapshot;
  private budgetReportedFor: string | undefined;
  /** Serializes accounting so two turns cannot both flush and double-count. */
  private accountingTail: Promise<void> = Promise.resolve();

  constructor(host: GoalRuntimeHost) {
    this.host = host;
    this.wallClock = { lastAccountedAt: this.now() };
  }

  on(listener: (event: GoalRuntimeEvent) => void): () => void {
    this.emitter.on('goal', listener);
    return () => this.emitter.off('goal', listener);
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  private emitEvent(event: GoalRuntimeEvent): void {
    this.emitter.emit('goal', event);
    this.host.emit(event);
  }

  private currentState(): GoalModeState | undefined {
    const state = this.host.getState();
    return state ? cloneState(state) : undefined;
  }

  private commit(
    state: GoalModeState | undefined,
    options?: { persist?: 'goal' | 'goal_paused' | 'none' },
  ): void {
    this.host.setState(state ? cloneState(state) : undefined);
    if (options?.persist) {
      this.host.persist(options.persist, state);
    }
    this.emitEvent({
      type: 'goal_updated',
      goal: state ? cloneGoal(state.goal) : null,
      state,
    });
  }

  /** True while tokens and time should keep accruing. */
  isAccounting(): boolean {
    const state = this.host.getState();
    return Boolean(state?.enabled && isAccountingStatus(state.goal.status));
  }

  getGoal(): Goal | null {
    const state = this.host.getState();
    return state ? cloneGoal(state.goal) : null;
  }

  getSnapshotState(): GoalModeState | undefined {
    return this.currentState();
  }

  /** Drops any partial accounting, e.g. when the turn is abandoned. */
  clearAccounting(): void {
    this.turnSnapshot = undefined;
    this.wallClock = { lastAccountedAt: this.now() };
    this.budgetReportedFor = undefined;
  }

  /**
   * Marks the start of a model call. Usage from here on is charged to the
   * goal, if one is active.
   */
  onTurnStart(turnId: string, baselineUsage: GoalTokenUsage): void {
    const state = this.host.getState();
    if (!state?.enabled || !isAccountingStatus(state.goal.status)) {
      this.turnSnapshot = undefined;
      return;
    }
    this.turnSnapshot = { turnId, baselineUsage: { ...baselineUsage } };
    this.wallClock = {
      lastAccountedAt: this.now(),
      goalId: state.goal.id,
    };
  }

  /**
   * Charges usage accrued since `onTurnStart` to the goal, and steers the
   * model to stop once the budget is gone.
   *
   * Safe to call more than once per turn: the baseline advances, so repeat
   * calls only charge what arrived since the previous one.
   */
  async onUsage(currentUsage: GoalTokenUsage): Promise<void> {
    const snapshot = this.turnSnapshot;
    if (!snapshot || !this.isAccounting()) {
      return;
    }
    const previous = this.accountingTail;
    let release!: () => void;
    this.accountingTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});

    try {
      this.accrue(currentUsage, snapshot);
    } catch (error) {
      debugLogger.warn(`[GoalRuntime] accounting failed: ${error}`);
    } finally {
      release();
    }
  }

  /** Charges usage and advances both the turn baseline and the wall clock. */
  private accrue(currentUsage: GoalTokenUsage, snapshot: TurnSnapshot): void {
    const state = this.currentState();
    if (!state || !isAccountingStatus(state.goal.status)) {
      this.turnSnapshot = undefined;
      return;
    }

    const charged = goalTokenDelta(currentUsage, snapshot.baselineUsage);
    const now = this.now();
    const elapsed =
      this.wallClock.goalId === state.goal.id
        ? Math.max(0, Math.floor((now - this.wallClock.lastAccountedAt) / 1000))
        : 0;

    state.goal.tokensUsed += charged;
    state.goal.timeUsedSeconds += elapsed;
    state.goal.updatedAt = now;
    this.wallClock = { lastAccountedAt: now, goalId: state.goal.id };
    // Re-baseline so a second call in the same turn charges only the new usage.
    snapshot.baselineUsage = { ...currentUsage };

    const exhausted =
      state.goal.tokenBudget !== undefined &&
      state.goal.tokensUsed >= state.goal.tokenBudget;
    if (exhausted && state.goal.status === 'active') {
      state.goal.status = 'budget-limited';
      this.commit(state, { persist: 'goal' });
      this.steerBudgetLimit(state.goal);
    } else {
      this.commit(state);
    }
  }

  /**
   * Tells the model to stop, once per goal. The budget-limit prompt is an
   * injection: it reaches the turn that overspent, which is the only point
   * where steering can still save tokens.
   */
  private steerBudgetLimit(goal: Goal): void {
    if (this.budgetReportedFor === goal.id) return;
    this.budgetReportedFor = goal.id;
    this.host.sendSteerMessage(renderGoalPrompt('budget-limit', goal));
  }

  create(objective: string, tokenBudget?: number): Goal {
    const trimmed = objective.trim();
    if (!trimmed) {
      throw new Error('objective is required');
    }
    validateTokenBudget(tokenBudget);

    const existing = this.host.getState();
    if (existing) {
      throw new Error(
        `A goal is already active: "${existing.goal.objective}". Complete or drop it before setting a new one.`,
      );
    }

    const now = this.now();
    const goal: Goal = {
      id: crypto.randomUUID(),
      objective: trimmed,
      status: 'active',
      tokenBudget,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.budgetReportedFor = undefined;
    this.wallClock = { lastAccountedAt: now, goalId: goal.id };
    this.turnSnapshot = undefined;

    this.commit({ enabled: true, mode: 'active', goal }, { persist: 'goal' });
    return cloneGoal(goal);
  }

  private requireState(): GoalModeState {
    const state = this.currentState();
    if (!state) {
      throw new Error('No goal is active. Use /goal to set one.');
    }
    return state;
  }

  complete(): Goal {
    const state = this.requireState();
    if (state.goal.status === 'complete' || state.goal.status === 'dropped') {
      throw new Error(`Goal is already ${state.goal.status}.`);
    }
    state.goal.status = 'complete';
    state.goal.updatedAt = this.now();
    this.clearAccounting();
    this.commit(state, { persist: 'none' });
    return cloneGoal(state.goal);
  }

  drop(): Goal {
    const state = this.requireState();
    state.goal.status = 'dropped';
    state.goal.updatedAt = this.now();
    this.clearAccounting();
    this.commit(state, { persist: 'none' });
    return cloneGoal(state.goal);
  }

  pause(): Goal {
    const state = this.requireState();
    state.goal.status = 'paused';
    state.goal.updatedAt = this.now();
    this.clearAccounting();
    this.commit(state, { persist: 'goal_paused' });
    return cloneGoal(state.goal);
  }

  resume(): Goal {
    const state = this.requireState();
    if (state.goal.status !== 'paused') {
      throw new Error(
        `Goal is ${state.goal.status}; only a paused goal can be resumed.`,
      );
    }
    state.goal.status = 'active';
    state.goal.updatedAt = this.now();
    this.budgetReportedFor = undefined;
    this.wallClock = { lastAccountedAt: this.now(), goalId: state.goal.id };
    this.commit(state, { persist: 'goal' });
    return cloneGoal(state.goal);
  }

  /** Restores a goal read back from the session record. */
  restore(state: GoalModeState): void {
    this.budgetReportedFor = undefined;
    this.wallClock = { lastAccountedAt: this.now(), goalId: state.goal.id };
    this.turnSnapshot = undefined;
    this.commit(cloneState(state));
  }

  /** Asks the host to run another turn, for a goal that is still active. */
  requestContinuation(): void {
    const state = this.currentState();
    if (!state || !state.enabled || !isAccountingStatus(state.goal.status)) {
      return;
    }
    this.emitEvent({
      type: 'goal_continuation_requested',
      prompt: renderGoalPrompt('continuation', state.goal),
    });
  }
}
