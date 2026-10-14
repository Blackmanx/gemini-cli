/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, renderWithProviders } from '../../../test-utils/render.js';
import { act } from 'react';
import { describe, it, expect } from 'vitest';
import { Box } from 'ink';
import { TodoTray } from './Todo.js';
import {
  CoreToolCallStatus,
  makeFakeConfig,
  type Todo,
  type TodoPhase,
} from '@google/gemini-cli-core';
import { UIStateContext, type UIState } from '../../contexts/UIStateContext.js';
import { type HistoryItem } from '../../types.js';

const createTodoHistoryItem = (todos: Todo[]): HistoryItem =>
  ({
    type: 'tool_group',
    id: '1',
    tools: [
      {
        name: 'write_todos',
        callId: 'tool-1',
        status: CoreToolCallStatus.Success,
        resultDisplay: {
          todos,
        },
      },
    ],
  }) as unknown as HistoryItem;

describe.each([true, false])(
  '<TodoTray /> (showFullTodos: %s)',
  async (showFullTodos: boolean) => {
    const renderWithUiState = async (uiState: Partial<UIState>) => {
      const result = await render(
        <UIStateContext.Provider value={uiState as UIState}>
          <TodoTray />
        </UIStateContext.Provider>,
      );
      return result;
    };

    it('renders null when no todos are in the history', async () => {
      const { lastFrame, unmount } = await renderWithUiState({
        history: [],
        showFullTodos,
      });
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('renders null when todo list is empty', async () => {
      const { lastFrame, unmount } = await renderWithUiState({
        history: [createTodoHistoryItem([])],
        showFullTodos,
      });
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });

    it('renders when todos exist but none are in progress', async () => {
      const { lastFrame, unmount } = await renderWithUiState({
        history: [
          createTodoHistoryItem([
            { description: 'Pending Task', status: 'pending' },
            { description: 'In Progress Task', status: 'cancelled' },
            { description: 'Completed Task', status: 'completed' },
          ]),
        ],
        showFullTodos,
      });
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders when todos exist and one is in progress', async () => {
      const { lastFrame, unmount } = await renderWithUiState({
        history: [
          createTodoHistoryItem([
            { description: 'Pending Task', status: 'pending' },
            { description: 'Task 2', status: 'in_progress' },
            { description: 'In Progress Task', status: 'cancelled' },
            { description: 'Completed Task', status: 'completed' },
          ]),
        ],
        showFullTodos,
      });
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders a todo list with long descriptions that wrap when full view is on', async () => {
      const { lastFrame, unmount } = await render(
        <Box width="50">
          <UIStateContext.Provider
            value={
              {
                history: [
                  createTodoHistoryItem([
                    {
                      description:
                        'This is a very long description for a pending task that should wrap around multiple lines when the terminal width is constrained.',
                      status: 'in_progress',
                    },
                    {
                      description:
                        'Another completed task with an equally verbose description to test wrapping behavior.',
                      status: 'completed',
                    },
                  ]),
                ],
                showFullTodos,
              } as UIState
            }
          >
            <TodoTray />
          </UIStateContext.Provider>
        </Box>,
      );
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders the most recent todo list when multiple write_todos calls are in history', async () => {
      const { lastFrame, unmount } = await renderWithUiState({
        history: [
          createTodoHistoryItem([
            { description: 'Older Task 1', status: 'completed' },
            { description: 'Older Task 2', status: 'pending' },
          ]),
          createTodoHistoryItem([
            { description: 'Newer Task 1', status: 'pending' },
            { description: 'Newer Task 2', status: 'in_progress' },
          ]),
        ],
        showFullTodos,
      });
      expect(lastFrame()).toMatchSnapshot();
      unmount();
    });

    it('renders full list when all todos are inactive', async () => {
      const { lastFrame, unmount } = await renderWithUiState({
        history: [
          createTodoHistoryItem([
            { description: 'Task 1', status: 'completed' },
            { description: 'Task 2', status: 'cancelled' },
          ]),
        ],
        showFullTodos,
      });
      expect(lastFrame({ allowEmpty: true })).toMatchSnapshot();
      unmount();
    });
  },
);

describe('TodoTray phase board (live runtime)', () => {
  const board = (): TodoPhase[] => [
    {
      name: 'Setup',
      tasks: [
        { content: 'Install deps', status: 'completed' },
        { content: 'Scaffold app', status: 'in_progress' },
      ],
    },
    {
      name: 'Build',
      tasks: [
        { content: 'Add API', status: 'pending' },
        { content: 'Wait on design', status: 'blocked', blocker: 'needs Figma' },
      ],
    },
  ];

  it('expanded renders each phase header, task labels, and a blocker note', async () => {
    const config = makeFakeConfig();
    config.getTodoRuntime().setPhases(board());
    const { lastFrame, unmount } = await renderWithProviders(<TodoTray />, {
      config,
      uiState: { showFullTodos: true },
    });
    const frame = lastFrame();
    expect(frame).toContain('Setup');
    expect(frame).toContain('Build');
    expect(frame).toContain('Install deps');
    expect(frame).toContain('Scaffold app');
    expect(frame).toContain('Add API');
    expect(frame).toContain('Wait on design — needs Figma');
    unmount();
  });

  it('collapsed shows only the active phase’s in-progress task', async () => {
    const config = makeFakeConfig();
    config.getTodoRuntime().setPhases(board());
    const { lastFrame, unmount } = await renderWithProviders(<TodoTray />, {
      config,
      uiState: { showFullTodos: false },
    });
    const frame = lastFrame();
    expect(frame).toContain('Scaffold app'); // the in-progress task
    expect(frame).not.toContain('Install deps'); // completed → hidden when collapsed
    expect(frame).not.toContain('Add API'); // other phase → hidden when collapsed
    unmount();
  });

  it('re-renders when the runtime emits a change', async () => {
    const config = makeFakeConfig();
    config.getTodoRuntime().setPhases(board());
    const { lastFrame, unmount, waitUntilReady } = await renderWithProviders(
      <TodoTray />,
      { config, uiState: { showFullTodos: true } },
    );
    expect(lastFrame()).toContain('Scaffold app');

    await act(async () => {
      config.getTodoRuntime().setPhases([
        { name: 'Done', tasks: [{ content: 'All finished', status: 'completed' }] },
      ]);
    });
    await waitUntilReady();

    const frame = lastFrame();
    expect(frame).toContain('Done');
    expect(frame).toContain('All finished');
    expect(frame).not.toContain('Scaffold app');
    unmount();
  });
});
