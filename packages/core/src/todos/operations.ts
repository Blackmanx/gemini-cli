/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  TodoCompletionTransition,
  TodoItem,
  TodoOperation,
  TodoParams,
  TodoPhase,
  TodoItemStatus,
} from './types.js';

// =============================================================================
// Cloning and lookup
// =============================================================================

/** Clones a task, preserving only fields the tool round-trips. */
export function cloneTask(task: TodoItem): TodoItem {
  return task.blocker !== undefined
    ? { content: task.content, status: task.status, blocker: task.blocker }
    : { content: task.content, status: task.status };
}

/** Deep-clones a phase list so callers can mutate without touching the source. */
export function clonePhases(phases: TodoPhase[]): TodoPhase[] {
  return phases.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map(cloneTask),
  }));
}

export function findTaskByContent(
  phases: TodoPhase[],
  content: string,
): { task: TodoItem; phase: TodoPhase } | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((t) => t.content === content);
    if (task) return { task, phase };
  }
  return undefined;
}

export function findPhaseByName(
  phases: TodoPhase[],
  name: string,
): TodoPhase | undefined {
  return phases.find((phase) => phase.name === name);
}

/** Whether an unknown value (e.g. persisted JSON) is a well-formed phase list. */
export function isTodoPhaseList(value: unknown): value is TodoPhase[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (phase) =>
      typeof phase === 'object' &&
      phase !== null &&
      typeof (phase as TodoPhase).name === 'string' &&
      Array.isArray((phase as TodoPhase).tasks) &&
      (phase as TodoPhase).tasks.every(
        (task) =>
          typeof task === 'object' &&
          task !== null &&
          typeof (task as TodoItem).content === 'string' &&
          isTodoStatus((task as TodoItem).status),
      ),
  );
}

const TODO_STATUSES: readonly TodoItemStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'abandoned',
  'blocked',
];

function isTodoStatus(value: unknown): value is TodoItemStatus {
  return TODO_STATUSES.includes(value as TodoItemStatus);
}

// =============================================================================
// Invariants and transitions
// =============================================================================

/**
 * Enforces the single-`in_progress` invariant and auto-promotes the first
 * pending task when nothing is in progress. Mutates `phases` in place.
 */
export function normalizeInProgressTask(phases: TodoPhase[]): void {
  const orderedTasks = phases.flatMap((phase) => phase.tasks);
  if (orderedTasks.length === 0) return;

  const inProgressTasks = orderedTasks.filter(
    (task) => task.status === 'in_progress',
  );
  if (inProgressTasks.length > 1) {
    for (const task of inProgressTasks.slice(1)) {
      task.status = 'pending';
    }
  }

  if (inProgressTasks.length > 0) return;

  const firstPendingTask = orderedTasks.find(
    (task) => task.status === 'pending',
  );
  if (firstPendingTask) firstPendingTask.status = 'in_progress';
}

/** The active task: the `in_progress` item, else the first pending one. */
export function nextActionableTask(
  phases: readonly TodoPhase[],
): TodoItem | undefined {
  let firstPending: TodoItem | undefined;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.status === 'in_progress') return task;
      if (!firstPending && task.status === 'pending') firstPending = task;
    }
  }
  return firstPending;
}

/** Whether a todo is settled: completed or deliberately abandoned. */
export function isClosedTodo(task: TodoItem): boolean {
  return task.status === 'completed' || task.status === 'abandoned';
}

function todoTransitionKey(phase: string, content: string): string {
  return `${phase}\u0000${content}`;
}

/** Tasks that flipped to `completed` between two snapshots. */
export function getCompletionTransitions(
  previous: TodoPhase[],
  updated: TodoPhase[],
): TodoCompletionTransition[] {
  const previousStatuses = new Map<string, TodoItemStatus>();
  for (const phase of previous) {
    for (const task of phase.tasks) {
      previousStatuses.set(
        todoTransitionKey(phase.name, task.content),
        task.status,
      );
    }
  }

  const transitions: TodoCompletionTransition[] = [];
  for (const phase of updated) {
    for (const task of phase.tasks) {
      if (task.status !== 'completed') continue;
      const previousStatus = previousStatuses.get(
        todoTransitionKey(phase.name, task.content),
      );
      if (previousStatus && previousStatus !== 'completed') {
        transitions.push({ phase: phase.name, content: task.content });
      }
    }
  }
  return transitions;
}

// =============================================================================
// Op application
// =============================================================================

/** Phase name for a flat `init` that supplied only `items`. */
const DEFAULT_INIT_PHASE = 'Tasks';

function resolveTaskOrError(
  phases: TodoPhase[],
  content: string | undefined,
  errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
  if (!content) {
    errors.push('Missing task content');
    return undefined;
  }
  const hit = findTaskByContent(phases, content);
  if (!hit) {
    const totalTasks = phases.reduce(
      (sum, phase) => sum + phase.tasks.length,
      0,
    );
    const hint =
      totalTasks === 0
        ? ' (todo list is empty — was it replaced or not yet created?)'
        : '';
    errors.push(`Task "${content}" not found${hint}`);
  }
  return hit;
}

function resolvePhaseOrError(
  phases: TodoPhase[],
  name: string | undefined,
  errors: string[],
): TodoPhase | undefined {
  if (!name) {
    errors.push('Missing phase name');
    return undefined;
  }
  const phase = findPhaseByName(phases, name);
  if (!phase) errors.push(`Phase "${name}" not found`);
  return phase;
}

function getTaskTargets(
  phases: TodoPhase[],
  entry: TodoParams,
  errors: string[],
): TodoItem[] {
  if (entry.task) {
    const hit = resolveTaskOrError(phases, entry.task, errors);
    return hit ? [hit.task] : [];
  }
  if (entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors);
    return phase ? [...phase.tasks] : [];
  }
  return phases.flatMap((phase) => phase.tasks);
}

function initPhases(entry: TodoParams, errors: string[]): TodoPhase[] {
  // Models routinely flatten a single-phase init into `{op:'init', items:[...]}`
  // (optionally with a bare `phase`) instead of the canonical
  // `list: [{phase, items}]`. Accept that shape by synthesizing a one-phase
  // list so a common, recoverable mistake isn't a hard error.
  const list =
    entry.list ??
    (entry.items && entry.items.length > 0
      ? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
      : undefined);
  if (!list) {
    errors.push('Missing list for init operation');
    return [];
  }
  // Duplicate phase names / task contents would be permanently unaddressable
  // (every targeting op resolves the first match), so reject them up front.
  const seenPhases = new Set<string>();
  const seenTasks = new Set<string>();
  for (const listEntry of list) {
    if (seenPhases.has(listEntry.phase)) {
      errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
    }
    seenPhases.add(listEntry.phase);
    for (const content of listEntry.items) {
      if (seenTasks.has(content)) {
        errors.push(`Duplicate task "${content}" in init list`);
      }
      seenTasks.add(content);
    }
  }
  return list.map((listEntry) => ({
    name: listEntry.phase,
    tasks: listEntry.items.map<TodoItem>((content) => ({
      content,
      status: 'pending',
    })),
  }));
}

function appendItems(
  phases: TodoPhase[],
  entry: TodoParams,
  errors: string[],
): TodoPhase[] {
  if (!entry.phase) {
    errors.push('Missing phase name for append operation');
    return phases;
  }
  if (!entry.items || entry.items.length === 0) {
    errors.push('Missing items for append operation');
    return phases;
  }

  // Validate the whole batch before mutating so a failing op reports every
  // duplicate and leaves nothing half-applied.
  const seen = new Set<string>();
  let hasDuplicate = false;
  for (const content of entry.items) {
    if (seen.has(content) || findTaskByContent(phases, content)) {
      errors.push(`Task "${content}" already exists`);
      hasDuplicate = true;
    }
    seen.add(content);
  }
  if (hasDuplicate) return phases;

  let phase = findPhaseByName(phases, entry.phase);
  if (!phase) {
    phase = { name: entry.phase, tasks: [] };
    phases.push(phase);
  }

  for (const content of entry.items) {
    phase.tasks.push({ content, status: 'pending' });
  }
  return phases;
}

function removeTasks(
  phases: TodoPhase[],
  entry: TodoParams,
  errors: string[],
): TodoPhase[] {
  if (entry.task) {
    const hit = resolveTaskOrError(phases, entry.task, errors);
    if (!hit) return phases;
    hit.phase.tasks = hit.phase.tasks.filter(
      (candidate) => candidate !== hit.task,
    );
    return phases;
  }
  if (entry.phase) {
    const phase = resolvePhaseOrError(phases, entry.phase, errors);
    if (!phase) return phases;
    phase.tasks = [];
    return phases;
  }
  for (const phase of phases) {
    phase.tasks = [];
  }
  return phases;
}

/** Applies a single op, collecting human-readable errors. Returns new phases. */
export function applyEntry(
  phases: TodoPhase[],
  entry: TodoParams,
  errors: string[],
): TodoPhase[] {
  switch (entry.op) {
    case 'init':
      return initPhases(entry, errors);
    case 'start': {
      const hit = resolveTaskOrError(phases, entry.task, errors);
      if (!hit) return phases;
      for (const phase of phases) {
        for (const candidate of phase.tasks) {
          if (candidate.status === 'in_progress' && candidate !== hit.task) {
            candidate.status = 'pending';
          }
        }
      }
      hit.task.status = 'in_progress';
      return phases;
    }
    case 'done': {
      for (const task of getTaskTargets(phases, entry, errors)) {
        task.status = 'completed';
      }
      return phases;
    }
    case 'drop': {
      for (const task of getTaskTargets(phases, entry, errors)) {
        task.status = 'abandoned';
      }
      return phases;
    }
    case 'block': {
      if (!entry.task && !entry.phase) {
        errors.push('block requires a task or phase target');
        return phases;
      }
      // Collapse whitespace runs (incl. newlines) to single spaces: a blocker
      // note rides on one Markdown checklist line and one HUD/summary line, so
      // an embedded newline would corrupt the round-trip parse and the render.
      const reason = entry.reason?.replace(/\s+/g, ' ').trim() || undefined;
      for (const task of getTaskTargets(phases, entry, errors)) {
        // Only actionable open work can be blocked: blocking a phase must not
        // reopen completed/abandoned tasks. An already-blocked task stays
        // eligible so a later block can refine its note.
        if (
          task.status !== 'pending' &&
          task.status !== 'in_progress' &&
          task.status !== 'blocked'
        ) {
          continue;
        }
        task.status = 'blocked';
        task.blocker = reason;
      }
      return phases;
    }
    case 'unblock': {
      if (!entry.task && !entry.phase) {
        errors.push('unblock requires a task or phase target');
        return phases;
      }
      for (const task of getTaskTargets(phases, entry, errors)) {
        if (task.status === 'blocked') {
          task.status = 'pending';
          task.blocker = undefined;
        }
      }
      return phases;
    }
    case 'rm':
      return removeTasks(phases, entry, errors);
    case 'append':
      return appendItems(phases, entry, errors);
    case 'view':
      return phases;
    default:
      throw new Error(`unhandled todo op: ${entry.op satisfies never}`);
  }
}

/**
 * Infers a missing `op` from the raw argument shape. Only unambiguous shapes
 * are inferred:
 * - `list` → `init` (list is init-only)
 * - `items` + `phase` → `append`
 * - bare `items` with no existing todos → `init` (nothing to overwrite)
 * Targeting args alone (`task`/`phase`) map to several ops and stay an error.
 */
export function inferTodoOp(
  args: Record<string, unknown>,
  hasExistingPhases: boolean,
): TodoOperation | undefined {
  const list = args['list'];
  const items = args['items'];
  const phase = args['phase'];
  if (Array.isArray(list) && list.length > 0) return 'init';
  if (Array.isArray(items) && items.length > 0) {
    if (typeof phase === 'string' && phase) return 'append';
    if (!hasExistingPhases) return 'init';
  }
  return undefined;
}

/**
 * Applies an array of ops to a copy of `currentPhases`, normalizing the
 * `in_progress` invariant once at the end. Returns the new list and any
 * collected errors. Used by both the tool and the `/todo` slash command.
 */
export function applyOpsToPhases(
  currentPhases: TodoPhase[],
  ops: TodoParams[],
): { phases: TodoPhase[]; errors: string[] } {
  const errors: string[] = [];
  let next = clonePhases(currentPhases);
  for (const op of ops) {
    next = applyEntry(next, op, errors);
  }
  normalizeInProgressTask(next);
  return { phases: next, errors };
}

// =============================================================================
// Substring matching (task addressing by content)
// =============================================================================

/**
 * Minimum overlap (after normalization) required for a substring match.
 * Six chars admits single-word identifiers like "review" without admitting
 * tiny common substrings like "test"/"fix" that collide across todos.
 */
const TODO_MATCH_MIN_OVERLAP = 6;

function normalizeForTodoMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function matchesNormalizedCandidates(
  target: string,
  candidates: readonly string[],
): boolean {
  if (!target) return false;
  for (const candidate of candidates) {
    if (target === candidate) return true;
    if (target.length >= TODO_MATCH_MIN_OVERLAP && candidate.includes(target))
      return true;
    if (candidate.length >= TODO_MATCH_MIN_OVERLAP && target.includes(candidate))
      return true;
  }
  return false;
}

/**
 * Whether `content` likely names the same work as any entry in
 * `descriptions`. Used to light up a pending todo when an in-flight subagent
 * is doing its work, without flipping the status.
 */
export function todoMatchesAnyDescription(
  content: string,
  descriptions: readonly string[],
): boolean {
  const target = normalizeForTodoMatch(content);
  if (!target) return false;
  const candidates: string[] = [];
  for (const desc of descriptions) {
    const candidate = normalizeForTodoMatch(desc);
    if (candidate) candidates.push(candidate);
  }
  return matchesNormalizedCandidates(target, candidates);
}

// =============================================================================
// Markdown round-trip
// =============================================================================

const STATUS_TO_MARKER: Record<TodoItemStatus, string> = {
  pending: ' ',
  in_progress: '/',
  completed: 'x',
  abandoned: '-',
  blocked: '!',
};

const MARKER_TO_STATUS: Record<string, TodoItemStatus> = {
  ' ': 'pending',
  '': 'pending',
  x: 'completed',
  X: 'completed',
  '/': 'in_progress',
  '>': 'in_progress',
  '-': 'abandoned',
  '~': 'abandoned',
  '!': 'blocked',
};

/** Renders todo phases as a Markdown checklist, for editing/copying/export. */
export function phasesToMarkdown(phases: TodoPhase[]): string {
  if (phases.length === 0) return '# Todos\n';
  const out: string[] = [];
  for (let i = 0; i < phases.length; i++) {
    if (i > 0) out.push('');
    out.push(`# ${phases[i].name}`);
    for (const task of phases[i].tasks) {
      // A blocked task's reason rides in a trailing HTML comment: invisible in
      // rendered markdown, unambiguous to parse back, so it survives `/todo
      // edit` and export/import round-trips.
      const blockerNote =
        task.status === 'blocked' && task.blocker
          ? ` <!-- blocker: ${task.blocker} -->`
          : '';
      out.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}${blockerNote}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/** Parses a Markdown checklist back into todo phases. */
export function markdownToPhases(md: string): {
  phases: TodoPhase[];
  errors: string[];
} {
  const errors: string[] = [];
  const phases: TodoPhase[] = [];
  let currentPhase: TodoPhase | undefined;

  const lines = md.split(/\r?\n/);
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const trimmed = lines[lineNum].trim();
    if (!trimmed) continue;

    const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
    if (headingMatch) {
      currentPhase = { name: headingMatch[1].trim(), tasks: [] };
      phases.push(currentPhase);
      continue;
    }

    // Tolerate backslash-escaped brackets (`- \[x\]`): some editors escape
    // `[`/`]` when round-tripping, yet the line still renders as a checkbox.
    const taskMatch =
      /^[-*+]\s*\\?\[(.?)\\?\]\s+(.+?)\s*$/.exec(trimmed);
    if (taskMatch) {
      if (!currentPhase) {
        currentPhase = { name: 'Todos', tasks: [] };
        phases.push(currentPhase);
      }
      const marker = taskMatch[1];
      const status = MARKER_TO_STATUS[marker];
      if (!status) {
        errors.push(
          `Line ${lineNum + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-], [!])`,
        );
        continue;
      }
      const rawContent = taskMatch[2].trim();
      const blockerMatch =
        /^(.*?)\s*<!--\s*blocker:\s*(.*?)\s*-->$/.exec(rawContent);
      if (status === 'blocked' && blockerMatch) {
        currentPhase.tasks.push({
          content: blockerMatch[1].trim(),
          status,
          blocker: blockerMatch[2].trim(),
        });
      } else {
        currentPhase.tasks.push({ content: rawContent, status });
      }
      continue;
    }

    errors.push(`Line ${lineNum + 1}: unrecognized syntax "${trimmed}"`);
  }

  normalizeInProgressTask(phases);
  return { phases, errors };
}

// =============================================================================
// Summary (returned to the model)
// =============================================================================

/** The text handed back to the model after an op. */
export function formatSummary(
  phases: TodoPhase[],
  errors: string[],
  readOnly = false,
): string {
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length === 0) {
    if (errors.length > 0) return `Errors: ${errors.join('; ')}`;
    return readOnly ? 'Todo list is empty.' : 'Todo list cleared.';
  }

  const remainingByPhase = phases
    .map((phase) => ({
      name: phase.name,
      tasks: phase.tasks.filter(
        (task) => task.status === 'pending' || task.status === 'in_progress',
      ),
    }))
    .filter((phase) => phase.tasks.length > 0);
  const remainingTasks = remainingByPhase.flatMap((phase) =>
    phase.tasks.map((task) => ({ ...task, phase: phase.name })),
  );

  let currentIdx = phases.findIndex((phase) =>
    phase.tasks.some(
      (task) => task.status === 'pending' || task.status === 'in_progress',
    ),
  );
  if (currentIdx === -1) currentIdx = phases.length - 1;
  const current = phases[currentIdx];
  const done = current.tasks.filter(
    (task) => task.status === 'completed' || task.status === 'abandoned',
  ).length;

  const lines: string[] = [];
  if (errors.length > 0) lines.push(`Errors: ${errors.join('; ')}`);
  if (remainingTasks.length === 0) {
    lines.push('Remaining items: none.');
  } else {
    lines.push(`Remaining items (${remainingTasks.length}):`);
    for (const task of remainingTasks) {
      lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
    }
  }
  const closedAll = tasks.filter(
    (task) => task.status === 'completed' || task.status === 'abandoned',
  ).length;
  const blockedAll = tasks.filter((task) => task.status === 'blocked').length;
  lines.push(
    `Overall: ${closedAll}/${tasks.length} done, ${remainingTasks.length} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ''}.`,
  );
  lines.push(
    `Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length}).`,
  );
  for (const phase of phases) {
    lines.push(`  ${phase.name}:`);
    for (const task of phase.tasks) {
      const checkbox = task.status === 'completed' ? '[X]' : '[ ]';
      const tag =
        task.status === 'in_progress'
          ? ' (in progress)'
          : task.status === 'abandoned'
            ? ' (dropped)'
            : task.status === 'blocked'
              ? task.blocker
                ? ` (blocked: ${task.blocker})`
                : ' (blocked)'
              : '';
      lines.push(`    - ${checkbox} ${task.content}${tag}`);
    }
  }
  return lines.join('\n');
}
