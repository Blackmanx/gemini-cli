/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import {
  applyOpsToPhases,
  clonePhases,
  isTodoPhaseList,
} from './operations.js';
import type { TodoParams, TodoPhase } from './types.js';

/** What the todo runtime tells the outside world. */
export type TodoRuntimeEvent = {
  type: 'todo_updated';
  phases: TodoPhase[];
};

/** Capabilities the todo runtime borrows from its host (the `Config`). */
export interface TodoRuntimeHost {
  /** Make the board durable so it survives a session resume. */
  persist(phases: TodoPhase[]): void;
  emit(event: TodoRuntimeEvent): void;
}

/** Result of applying one or more ops through the runtime. */
export interface TodoApplyResult {
  phases: TodoPhase[];
  errors: string[];
}

/**
 * Owns the session's todo board: its current phases, the ops that mutate it,
 * and the persistence/event plumbing.
 *
 * State changes only land when an op batch applies cleanly — a batch with any
 * error is discarded wholesale, so the model's natural retry doesn't collide
 * with a half-applied change.
 */
export class TodoRuntime {
  private readonly host: TodoRuntimeHost;
  private readonly emitter = new EventEmitter();
  private phases: TodoPhase[] = [];

  constructor(host: TodoRuntimeHost) {
    this.host = host;
  }

  onChange(listener: (event: TodoRuntimeEvent) => void): () => void {
    this.emitter.on('todo', listener);
    return () => this.emitter.off('todo', listener);
  }

  /** Defensive clone of the current board. */
  getPhases(): TodoPhase[] {
    return clonePhases(this.phases);
  }

  /** Whether any todos have been created this session. */
  hasPhases(): boolean {
    return this.phases.length > 0;
  }

  /**
   * Applies a batch of ops. Commits (persists + emits) only when the batch
   * applied with no errors; otherwise the board is left untouched.
   */
  applyOps(ops: TodoParams[]): TodoApplyResult {
    const { phases, errors } = applyOpsToPhases(this.phases, ops);
    if (errors.length === 0) {
      this.commit(phases);
    }
    return { phases, errors };
  }

  /** Replaces the board wholesale (used by `/todo edit` and imports). */
  setPhases(phases: TodoPhase[]): void {
    this.commit(clonePhases(phases));
  }

  /** Restores a board read back from the session record without re-persisting. */
  restore(phases: unknown): void {
    if (!isTodoPhaseList(phases)) return;
    this.phases = clonePhases(phases);
    this.emitEvent();
  }

  private commit(phases: TodoPhase[]): void {
    this.phases = clonePhases(phases);
    this.host.persist(this.getPhases());
    this.emitEvent();
  }

  private emitEvent(): void {
    const event: TodoRuntimeEvent = {
      type: 'todo_updated',
      phases: this.getPhases(),
    };
    this.emitter.emit('todo', event);
    this.host.emit(event);
  }
}
