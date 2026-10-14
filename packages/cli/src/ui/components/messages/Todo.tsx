/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useContext, useEffect, useMemo, useState } from 'react';
import { type TodoItem, type TodoList, type TodoPhase } from '@google/gemini-cli-core';
import { ConfigContext } from '../../contexts/ConfigContext.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import type { HistoryItemToolGroup } from '../../types.js';
import { Checklist } from '../Checklist.js';
import type { ChecklistItemData } from '../ChecklistItem.js';
import { formatCommand } from '../../key/keybindingUtils.js';
import { Command } from '../../key/keyBindings.js';

/** Maps a todo item to checklist data, surfacing a blocker note on the label. */
function toChecklistItem(task: TodoItem): ChecklistItemData {
  return {
    status: task.status,
    label: task.blocker ? `${task.content} — ${task.blocker}` : task.content,
  };
}

/**
 * A persistent tray showing the session's todo board.
 *
 * The board is read from the live `TodoRuntime` (via `Config`) and re-renders
 * on every change, so tool calls, `/resume` restores and `/todo` edits all show
 * up here. When no phase board exists it falls back to scanning history for a
 * flat `TodoList` (the tracker's output), which keeps that feature working.
 */
export const TodoTray: React.FC = () => {
  const uiState = useUIState();
  const config = useContext(ConfigContext);

  // Live phase board, kept in sync with the runtime. Method calls are optional
  // so partial Config fixtures in tests (which don't stub the todo runtime)
  // render the tray empty instead of throwing; the real Config always has them.
  const [phases, setPhases] = useState<TodoPhase[]>(() =>
    config?.getTodoPhases?.() ?? [],
  );

  useEffect(() => {
    if (!config?.getTodoPhases) return;
    setPhases(config.getTodoPhases() ?? []);
    return config.onTodoEvent?.((event) => setPhases(event.phases));
  }, [config]);

  // Legacy fallback: the most recent flat TodoList in history (tracker output).
  const legacyTodos: TodoList | null = useMemo(() => {
    if (phases.length > 0) return null;
    for (let i = uiState.history.length - 1; i >= 0; i--) {
      const entry = uiState.history[i];
      if (entry.type !== 'tool_group') continue;
      const toolGroup = entry as HistoryItemToolGroup;
      for (const tool of toolGroup.tools) {
        if (
          typeof tool.resultDisplay !== 'object' ||
          !('todos' in tool.resultDisplay)
        ) {
          continue;
        }
        return tool.resultDisplay as TodoList;
      }
    }
    return null;
  }, [phases, uiState.history]);

  const toggleHint = `${formatCommand(Command.SHOW_FULL_TODOS)} to toggle`;

  // Live phase board: collapsed shows only the active phase's current task;
  // expanded shows every non-empty phase with its own header.
  if (phases.length > 0) {
    const hasInProgress = (phase: TodoPhase) =>
      phase.tasks.some((task) => task.status === 'in_progress');
    const isOpen = (phase: TodoPhase) =>
      phase.tasks.some(
        (task) =>
          task.status === 'pending' ||
          task.status === 'in_progress' ||
          task.status === 'blocked',
      );

    const visible: Array<{ phase: TodoPhase; index: number }> = [];
    if (uiState.showFullTodos) {
      phases.forEach((phase, index) => {
        if (phase.tasks.length > 0) visible.push({ phase, index });
      });
    } else {
      // Prefer the phase with the in-progress task; else the first with open work.
      const index = phases.findIndex(hasInProgress);
      const fallback = index === -1 ? phases.findIndex(isOpen) : index;
      if (fallback !== -1) {
        visible.push({ phase: phases[fallback], index: fallback });
      }
    }

    if (visible.length === 0) return null;

    return (
      <>
        {visible.map(({ phase, index }, position) => (
          <Checklist
            key={`${index}-${phase.name}`}
            title={phase.name}
            items={phase.tasks.map(toChecklistItem)}
            isExpanded={uiState.showFullTodos}
            toggleHint={position === 0 ? toggleHint : undefined}
          />
        ))}
      </>
    );
  }

  // Legacy flat todo list (tracker).
  if (!legacyTodos || !legacyTodos.todos) {
    return null;
  }
  const checklistItems: ChecklistItemData[] = legacyTodos.todos.map((todo) => ({
    status: todo.status,
    label: todo.description,
  }));

  return (
    <Checklist
      title="Todo"
      items={checklistItems}
      isExpanded={uiState.showFullTodos}
      toggleHint={toggleHint}
    />
  );
};
