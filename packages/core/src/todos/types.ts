/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Canonical types for the op-based todo system, ported from omp's `todo`
 * tool.
 *
 * The model mutates a phase-grouped list through small operations (`init`,
 * `start`, `done`, …) instead of re-sending the whole list on every change.
 * Tasks are addressed by their verbatim `content` — there are no IDs — so the
 * text a task was created with is its identity for the life of the list.
 */

/** Lifecycle state of a todo item. */
export type TodoItemStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'abandoned'
  | 'blocked';

/** Operations accepted by the `todo` tool, echoed in successful result details. */
export type TodoOperation =
  | 'init'
  | 'start'
  | 'done'
  | 'rm'
  | 'drop'
  | 'block'
  | 'unblock'
  | 'append'
  | 'view';

/** A task within a todo phase. `content` is the task's identity. */
export interface TodoItem {
  content: string;
  status: TodoItemStatus;
  /** When `status === 'blocked'`, a note on what the task is waiting for. */
  blocker?: string;
  /** Optional longer-form detail; not exposed through the tool schema. */
  details?: string;
  /** Optional running notes; not exposed through the tool schema. */
  notes?: string[];
}

/** A named, ordered group of todo tasks. */
export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

/** A task that transitioned to `completed` in the latest operation. */
export interface TodoCompletionTransition {
  phase: string;
  content: string;
}

/**
 * The structured payload the `todo` tool returns as its `returnDisplay`, and
 * what the UI reads to render the board.
 */
export interface TodoBoard {
  phases: TodoPhase[];
  /** The operation that produced this snapshot; absent on legacy entries. */
  op?: TodoOperation;
  /** Tasks that just became `completed` in this update (drives the strike animation). */
  completedTasks?: TodoCompletionTransition[];
}

/** Tool result details: the committed snapshot plus how it was stored. */
export interface TodoToolDetails extends TodoBoard {
  /** Where the list lives for this session. */
  storage: 'session' | 'memory';
}

/** Parameters the `todo` tool accepts. Every field is op-dependent. */
export interface TodoParams {
  op: TodoOperation;
  /** Phases for `init`: `[{ phase, items }]`. */
  list?: Array<{ phase: string; items: string[] }>;
  /** Verbatim task content, used to target a single task. */
  task?: string;
  /** Phase name, used to target a whole phase. */
  phase?: string;
  /** Tasks for a flat `init` or for `append`. */
  items?: string[];
  /** Blocker note for `block`. */
  reason?: string;
}

/**
 * What a session record keeps so a resumed session finds its board again.
 *
 * Mirrors `PersistedGoalState`: todos are session state, not something the
 * user said, so they are stored as metadata and never re-sent to the model.
 */
export interface PersistedTodoState {
  phases: TodoPhase[];
}
