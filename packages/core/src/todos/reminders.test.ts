/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildMidRunNudge,
  buildStopTimeReminder,
  hasIncompleteTodos,
  isAwaitingUserAnswer,
} from './reminders.js';
import type { TodoPhase } from './types.js';

describe('isAwaitingUserAnswer', () => {
  it('detects a direct question addressed to the user', () => {
    // The heuristic is line-based and ^-anchored: the question must open its line.
    expect(
      isAwaitingUserAnswer('I refactored the parser.\nShould I rename it too?'),
    ).toBe(true);
  });

  it('detects a question using you/our without a leading question word', () => {
    expect(
      isAwaitingUserAnswer('The migration is staged.\nDo you want me to push it?'),
    ).toBe(true);
  });

  it('stays silent on a plain statement that ends the turn', () => {
    expect(
      isAwaitingUserAnswer(
        'I finished the refactor and the full test suite passes now.',
      ),
    ).toBe(false);
  });

  it('does not treat an incidental "?" inside prose as a user question', () => {
    // The `?` is mid-sentence TypeScript, not the last line, and the closing
    // line is a statement — so no reminder should be suppressed.
    expect(
      isAwaitingUserAnswer(
        'I set the flag `retries?: number` in the config.\nThe build is green.',
      ),
    ).toBe(false);
  });

  it('treats a trailing response cue ("please confirm …") as waiting on the user', () => {
    expect(
      isAwaitingUserAnswer('Everything is wired up.\nPlease confirm to deploy.'),
    ).toBe(true);
  });

  it('treats two options plus a recommendation as a user decision', () => {
    const text = [
      'Which approach do you prefer?',
      '- Option A: keep the cache',
      '- Option B: drop the cache',
      'I would recommend Option A.',
    ].join('\n');
    expect(isAwaitingUserAnswer(text)).toBe(true);
  });

  it('resumes when a self-answered question is followed by actual prose', () => {
    // A question appears earlier but the turn ends on a statement, so the model
    // is not waiting on the user and a stop-time reminder may fire.
    expect(
      isAwaitingUserAnswer(
        'Should I keep the old API?\nI went ahead and kept it; tests pass.',
      ),
    ).toBe(false);
  });
});

describe('hasIncompleteTodos', () => {
  const board = (statuses: TodoPhase['tasks'][number]['status'][]): TodoPhase[] => [
    {
      name: 'Work',
      tasks: statuses.map((status, i) => ({ content: `t${i}`, status })),
    },
  ];

  it('is true while any task is pending or in progress', () => {
    expect(hasIncompleteTodos(board(['pending']))).toBe(true);
    expect(hasIncompleteTodos(board(['in_progress']))).toBe(true);
  });

  it('is false when every task is finished, abandoned, or blocked', () => {
    expect(hasIncompleteTodos(board(['completed', 'abandoned', 'blocked']))).toBe(
      false,
    );
  });

  it('is false for an empty board', () => {
    expect(hasIncompleteTodos([])).toBe(false);
  });
});

describe('buildStopTimeReminder', () => {
  const phases: TodoPhase[] = [
    {
      name: 'Setup',
      tasks: [
        { content: 'Install deps', status: 'completed' },
        { content: 'Scaffold app', status: 'in_progress' },
      ],
    },
    {
      name: 'Build',
      tasks: [{ content: 'Add API', status: 'pending' }],
    },
  ];

  it('names the incomplete count, the leftover tasks, and the attempt bound', () => {
    const reminder = buildStopTimeReminder(phases, 2, 3);
    expect(reminder).toContain('<system-reminder>');
    expect(reminder).toContain('You stopped with 2 incomplete todo item(s)');
    expect(reminder).toContain('Scaffold app');
    expect(reminder).toContain('Add API');
    // Completed work is not re-nudged.
    expect(reminder).not.toContain('Install deps');
    expect(reminder).toContain('(Reminder 2/3)');
  });
});

describe('buildMidRunNudge', () => {
  it('reports the leftover count and tasks so the model reconciles the board', () => {
    const nudge = buildMidRunNudge([
      { name: 'Build', tasks: [{ content: 'Add API', status: 'pending' }] },
    ]);
    expect(nudge).toContain('<system-reminder>');
    expect(nudge).toContain('1 todo item(s) remain incomplete');
    expect(nudge).toContain('Add API');
    expect(nudge).toContain('Reconcile the todo list');
  });
});
