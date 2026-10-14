/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findPhaseByName,
  findTaskByContent,
  markdownToPhases,
  phasesToMarkdown,
  type Config,
  type TodoOperation,
  type TodoParams,
  type TodoPhase,
} from '@google/gemini-cli-core';
import { theme } from '../semantic-colors.js';
import {
  CommandKind,
  type CommandContext,
  type OpenCustomDialogActionReturn,
  type SlashCommand,
} from './types.js';
import { openFileInEditor } from '../utils/editorUtils.js';
import { useUIActions } from '../contexts/UIActionsContext.js';

/**
 * A command's output is returned, never pushed onto the UI directly — the
 * processor owns that bookkeeping (see `goalCommand`).
 */
function say(content: string, messageType: 'info' | 'error' = 'info') {
  return { type: 'message', messageType, content } as const;
}

function todoConfig(context: CommandContext) {
  return context.services.agentContext?.config;
}

/**
 * Tells the model the board changed. `/todo` mutates outside the tool, so the
 * model would otherwise keep acting on a stale list; this keeps its next turn
 * in sync without a user-visible message.
 */
function notifyModelOfBoard(config: Config) {
  const client = config.getGeminiClient?.();
  if (!client?.isInitialized()) return;
  const markdown = phasesToMarkdown(config.getTodoPhases());
  // Fire-and-forget: a failed notification must never break the /todo command.
  void Promise.resolve(
    client.addHistory({
      role: 'user',
      parts: [
        {
          text:
            '<system-reminder>The user updated the session todo list via /todo. ' +
            'Treat this board as the source of truth and continue accordingly.\n\n' +
            markdown +
            '</system-reminder>',
        },
      ],
    }),
  ).catch(() => {
    /* ignore */
  });
}

/** Resolves a task by exact content, else a unique case-insensitive substring. */
function resolveTask(
  phases: TodoPhase[],
  text: string,
): { content: string } | { error: string } {
  const t = text.trim();
  if (!t) return { error: 'Missing task text.' };
  if (findTaskByContent(phases, t)) return { content: t };
  const lower = t.toLowerCase();
  const matches: string[] = [];
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.content.toLowerCase().includes(lower)) matches.push(task.content);
    }
  }
  if (matches.length === 1) return { content: matches[0] };
  if (matches.length === 0) return { error: `No task matches "${t}".` };
  return {
    error: `Ambiguous task "${t}" matches ${matches
      .map((m) => `"${m}"`)
      .join(', ')}. Be more specific.`,
  };
}

/** Subcommands that map one-to-one onto a single-task todo operation. */
const TASK_OPS: Record<string, TodoOperation> = {
  done: 'done',
  start: 'start',
  drop: 'drop',
  unblock: 'unblock',
};

const SUBCOMMAND_NAMES = [
  'view',
  'edit',
  'done',
  'start',
  'drop',
  'block',
  'unblock',
  'rm',
  'clear',
];

/**
 * A dialog that hosts the external editor. Slash commands are plain functions
 * with no `stdin`/`setRawMode`, so the editor flow runs inside this component
 * (which has `useStdin`) and closes itself via `onClose`.
 */
const TodoEditDialog: React.FC<{
  config: Config;
  markdown: string;
  onClose: () => void;
}> = ({ config, markdown, onClose }) => {
  const { stdin, setRawMode } = useStdin();
  const { getPreferredEditor } = useUIActions();
  const [error, setError] = useState<string | undefined>(undefined);
  const tmpPathRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const p = path.join(
      os.tmpdir(),
      `gemini-todo-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.md`,
    );
    fs.writeFileSync(p, markdown, 'utf8');
    tmpPathRef.current = p;
    return () => {
      try {
        fs.unlinkSync(p);
      } catch {
        /* best-effort cleanup */
      }
    };
  }, [markdown]);

  const openEditor = useCallback(async () => {
    const p = tmpPathRef.current;
    if (!p) return;
    setError(undefined);
    // Falls back to $VISUAL/$EDITOR, then vi, when no preferred editor is set.
    await openFileInEditor(p, stdin, setRawMode, getPreferredEditor());
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    const { phases, errors } = markdownToPhases(text);
    if (errors.length > 0) {
      // Stay open so the user can fix the offending lines and re-edit.
      setError(errors.join('; '));
      return;
    }
    config.getTodoRuntime().setPhases(phases);
    notifyModelOfBoard(config);
    onClose();
  }, [stdin, setRawMode, getPreferredEditor, config, onClose]);

  // Open the editor as soon as the dialog is shown.
  useEffect(() => {
    void openEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (error && key.return) {
      void openEditor();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color={theme.text.primary} bold>
        Editing todos
      </Text>
      <Text color={theme.text.secondary}>
        Edit the Markdown checklist, then save and close your editor to apply.
      </Text>
      {error ? (
        <Text color={theme.status.error}>
          {error} — press Enter to re-edit, Esc to cancel.
        </Text>
      ) : (
        <Text color={theme.text.secondary}>Waiting for your editor…</Text>
      )}
    </Box>
  );
};

/**
 * `/todo` views and edits the session todo list. Any text that is not a known
 * subcommand is treated as `view`, so plain `/todo` shows the board.
 *
 * Subcommands are intentionally not declared in `subCommands`: the parser
 * consumes declared names out of `args`, which would strip the task text this
 * action needs. Completion is provided separately instead.
 */
export const todoCommand: SlashCommand = {
  name: 'todo',
  description: 'View or update the session todo list',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  // Viewing and ticking off items are safe while the model works.
  isSafeConcurrent: true,
  completion: (_context, partialArg) => {
    const [first, ...rest] = partialArg.split(/\s+/);
    if (rest.length > 0 || partialArg.includes(' ')) return [];
    return SUBCOMMAND_NAMES.filter((name) => name.startsWith(first ?? ''));
  },
  action: async (context, args) => {
    const config = todoConfig(context);
    if (!config) return say('No active session.', 'error');
    const runtime = config.getTodoRuntime();

    const trimmed = (args ?? '').trim();
    const [firstWord, ...rest] = trimmed ? trimmed.split(/\s+/) : [];
    const sub = firstWord ?? 'view';
    const restText = rest.join(' ').trim();

    if (sub === 'view') {
      const phases = runtime.getPhases();
      if (phases.length === 0) {
        return say('No todos yet. The model creates them with the todo tool.');
      }
      return say(phasesToMarkdown(phases));
    }

    if (sub === 'edit') {
      const markdown = phasesToMarkdown(runtime.getPhases());
      return {
        type: 'custom_dialog',
        component: React.createElement(TodoEditDialog, {
          config,
          markdown,
          onClose: () => context.ui.removeComponent(),
        }),
      } satisfies OpenCustomDialogActionReturn;
    }

    if (sub === 'clear') {
      runtime.setPhases([]);
      notifyModelOfBoard(config);
      return say('Todo list cleared.');
    }

    if (sub === 'block') {
      // `/todo block <task> [-- <reason>]`
      const sep = restText.indexOf('--');
      const taskText = sep === -1 ? restText : restText.slice(0, sep).trim();
      const reason =
        sep === -1 ? undefined : restText.slice(sep + 2).trim() || undefined;
      const resolved = resolveTask(runtime.getPhases(), taskText);
      if ('error' in resolved) return say(resolved.error, 'error');
      const { errors } = runtime.applyOps([
        { op: 'block', task: resolved.content, reason },
      ]);
      if (errors.length > 0) return say(errors.join('; '), 'error');
      notifyModelOfBoard(config);
      return say(
        `Blocked: ${resolved.content}${reason ? ` — ${reason}` : ''}`,
      );
    }

    const taskOp = TASK_OPS[sub];
    if (taskOp) {
      const resolved = resolveTask(runtime.getPhases(), restText);
      if ('error' in resolved) return say(resolved.error, 'error');
      const { errors } = runtime.applyOps([
        { op: taskOp, task: resolved.content },
      ] as TodoParams[]);
      if (errors.length > 0) return say(errors.join('; '), 'error');
      notifyModelOfBoard(config);
      return say(`${sub}: ${resolved.content}`);
    }

    if (sub === 'rm') {
      const t = restText.trim();
      if (!t) return say('Usage: /todo rm <task or phase>', 'error');
      const phases = runtime.getPhases();
      if (findTaskByContent(phases, t)) {
        const { errors } = runtime.applyOps([{ op: 'rm', task: t }]);
        if (errors.length > 0) return say(errors.join('; '), 'error');
        notifyModelOfBoard(config);
        return say(`Removed task: ${t}`);
      }
      if (findPhaseByName(phases, t)) {
        const { errors } = runtime.applyOps([{ op: 'rm', phase: t }]);
        if (errors.length > 0) return say(errors.join('; '), 'error');
        notifyModelOfBoard(config);
        return say(`Cleared phase: ${t}`);
      }
      return say(`No task or phase matches "${t}".`, 'error');
    }

    return say(
      `Unknown subcommand "${sub}". Use view, edit, done, start, drop, block, unblock, rm, clear — or just /todo to view.`,
      'error',
    );
  },
};
