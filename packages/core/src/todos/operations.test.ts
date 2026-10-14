/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  applyOpsToPhases,
  formatSummary,
  getCompletionTransitions,
  inferTodoOp,
  markdownToPhases,
  nextActionableTask,
  phasesToMarkdown,
  todoMatchesAnyDescription,
} from './operations.js';
import { TodoRuntime } from './runtime.js';
import type { TodoParams, TodoPhase } from './types.js';

function init(items: string[], phase = 'Work'): TodoParams {
  return { op: 'init', list: [{ phase, items }] };
}

function makeRuntime() {
  let committed: TodoPhase[] = [];
  const runtime = new TodoRuntime({
    persist: (phases) => {
      committed = phases;
    },
    emit: () => {},
  });
  return { runtime, committed: () => committed };
}

describe('todo operations', () => {
  it('init builds phases and auto-selects the first pending task as in_progress', () => {
    const { phases, errors } = applyOpsToPhases([], [
      { op: 'init', list: [{ phase: 'Work', items: ['a', 'b'] }, { phase: 'Later', items: ['c'] }] },
    ]);
    expect(errors).toEqual([]);
    expect(phases.map((p) => p.name)).toEqual(['Work', 'Later']);
    expect(phases[0].tasks[0].status).toBe('in_progress');
    expect(nextActionableTask(phases)?.content).toBe('a');
  });

  it('a second init replaces the whole list rather than merging', () => {
    const { phases } = applyOpsToPhases([], [init(['a', 'b']), init(['x'])]);
    expect(phases).toHaveLength(1);
    expect(phases[0].tasks.map((t) => t.content)).toEqual(['x']);
  });

  it('init accepts a flattened items payload as a single phase', () => {
    const { phases, errors } = applyOpsToPhases([], [
      { op: 'init', items: ['a', 'b'] },
    ]);
    expect(errors).toEqual([]);
    expect(phases).toHaveLength(1);
    expect(phases[0].name).toBe('Tasks');
  });

  it('start keeps exactly one in_progress task, demoting the previous one', () => {
    const { phases } = applyOpsToPhases([], [
      init(['a', 'b']),
      { op: 'start', task: 'b' },
    ]);
    expect(phases[0].tasks.map((t) => t.status)).toEqual([
      'pending',
      'in_progress',
    ]);
  });

  it('done auto-advances the pointer to the next pending task', () => {
    const { phases } = applyOpsToPhases([], [
      init(['a', 'b']),
      { op: 'done', task: 'a' },
    ]);
    expect(phases[0].tasks.map((t) => t.status)).toEqual([
      'completed',
      'in_progress',
    ]);
  });

  it('reports completion transitions only for tasks that newly flipped to completed', () => {
    const before: TodoPhase[] = [
      {
        name: 'W',
        tasks: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'in_progress' },
        ],
      },
    ];
    const after: TodoPhase[] = [
      {
        name: 'W',
        tasks: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'completed' },
        ],
      },
    ];
    expect(getCompletionTransitions(before, after)).toEqual([
      { phase: 'W', content: 'b' },
    ]);
  });

  it('block requires a target and records a normalized one-line reason', () => {
    const { errors } = applyOpsToPhases([], [
      init(['a']),
      { op: 'block', reason: 'waiting\non review' },
    ]);
    expect(errors).toContain('block requires a task or phase target');

    const blocked = applyOpsToPhases([], [
      init(['a']),
      { op: 'block', task: 'a', reason: 'waiting\non review' },
    ]);
    expect(blocked.phases[0].tasks[0]).toEqual({
      content: 'a',
      status: 'blocked',
      blocker: 'waiting on review',
    });
  });

  it('unblock clears the blocker and the task becomes the active one', () => {
    const { phases } = applyOpsToPhases([], [
      init(['a']),
      { op: 'block', task: 'a', reason: 'x' },
      { op: 'unblock', task: 'a' },
    ]);
    // Back to pending, then normalizeInProgressTask promotes the only open task.
    expect(phases[0].tasks[0].status).toBe('in_progress');
    expect(phases[0].tasks[0].blocker).toBeUndefined();
  });

  it('block never reopens completed work when targeting a phase', () => {
    const { phases } = applyOpsToPhases([], [
      init(['a', 'b']),
      { op: 'done', task: 'a' },
      { op: 'block', phase: 'Work' },
    ]);
    expect(phases[0].tasks.map((t) => t.status)).toEqual([
      'completed',
      'blocked',
    ]);
  });

  it('rm empties the targeted tasks but keeps the phase structure', () => {
    const base = (): TodoPhase[] => [
      { name: 'W', tasks: [{ content: 'a', status: 'pending' }] },
    ];
    expect(
      applyOpsToPhases(base(), [{ op: 'rm', task: 'a' }]).phases[0].tasks,
    ).toEqual([]);
    expect(
      applyOpsToPhases(base(), [{ op: 'rm', phase: 'W' }]).phases,
    ).toEqual([{ name: 'W', tasks: [] }]);
  });

  it('append creates the phase when it does not exist yet', () => {
    const { phases, errors } = applyOpsToPhases([], [
      init(['a'], 'One'),
      { op: 'append', phase: 'Two', items: ['b'] },
    ]);
    expect(errors).toEqual([]);
    expect(phases.map((p) => p.name)).toEqual(['One', 'Two']);
  });

  it('inferTodoOp only infers unambiguous shapes', () => {
    expect(inferTodoOp({ list: [{}] }, false)).toBe('init');
    expect(inferTodoOp({ items: ['a'], phase: 'P' }, true)).toBe('append');
    expect(inferTodoOp({ items: ['a'] }, false)).toBe('init');
    expect(inferTodoOp({ items: ['a'] }, true)).toBeUndefined();
    expect(inferTodoOp({ task: 'a' }, true)).toBeUndefined();
  });
});

describe('TodoRuntime atomicity', () => {
  it('a failing batch reports errors and leaves the committed board untouched', () => {
    const { runtime, committed } = makeRuntime();
    runtime.applyOps([init(['a', 'b'])]);
    expect(committed()).toHaveLength(1);

    const result = runtime.applyOps([
      { op: 'done', task: 'a' },
      { op: 'append', phase: 'Work', items: ['a'] }, // duplicate → error
    ]);
    expect(result.errors.some((e) => e.includes('already exists'))).toBe(true);
    // The `done` was part of the failing batch, so it must not have landed.
    expect(runtime.getPhases()[0].tasks[0].status).toBe('in_progress');
  });

  it('persists and emits only when a batch applies cleanly', () => {
    const { runtime, committed } = makeRuntime();
    runtime.applyOps([init(['a'])]);
    expect(committed()[0].tasks).toHaveLength(1);

    runtime.applyOps([{ op: 'start', task: 'missing' }]);
    // Failed op → committed snapshot is still the previous one.
    expect(committed()[0].tasks[0].content).toBe('a');
  });
});

describe('todo markdown round-trip', () => {
  it('preserves statuses and a blocked task’s reason through a round-trip', () => {
    const { phases } = applyOpsToPhases([], [
      init(['a', 'b', 'c']),
      { op: 'done', task: 'a' },
      { op: 'block', task: 'c', reason: 'needs review' },
    ]);
    const md = phasesToMarkdown(phases);
    const { phases: back, errors } = markdownToPhases(md);
    expect(errors).toEqual([]);
    expect(back[0].tasks).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'blocked', blocker: 'needs review' },
    ]);
  });

  it('tolerates backslash-escaped checkboxes some editors emit', () => {
    const { phases, errors } = markdownToPhases('# T\n- \\[x\\] done item\n');
    expect(errors).toEqual([]);
    expect(phases[0].tasks).toEqual([
      { content: 'done item', status: 'completed' },
    ]);
  });

  it('surfaces an unknown status marker as a per-line error', () => {
    const { errors } = markdownToPhases('# T\n- [?] weird\n');
    expect(errors[0]).toContain('unknown status marker');
  });
});

describe('todo substring matching', () => {
  it('links a description to a task only with enough normalized overlap', () => {
    expect(todoMatchesAnyDescription('Review Sonnet #2', ['Sonnet #2'])).toBe(
      true,
    );
    // "fix" is too short a common substring to claim a match.
    expect(todoMatchesAnyDescription('Fix the parser', ['prefix'])).toBe(false);
  });
});

describe('todo summary', () => {
  it('lists remaining tasks and an overall count for the model', () => {
    const { phases } = applyOpsToPhases([], [
      init(['a', 'b']),
      { op: 'done', task: 'a' },
    ]);
    const text = formatSummary(phases, []);
    expect(text).toContain('Overall: 1/2 done, 1 open');
    expect(text).toContain('- b [in_progress] (Work)');
  });
});
