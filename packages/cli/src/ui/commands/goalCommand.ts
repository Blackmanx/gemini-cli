/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from './types.js';
import {
  coreEvents,
  debugLogger,
  remainingTokens,
} from '@google/gemini-cli-core';

type GoalSubcommand = 'set' | 'show' | 'pause' | 'resume' | 'drop' | 'clear';

const BUDGET_HINT = 'Use `/goal <objective>` to set one.';

const GOAL_SUBCOMMANDS: Record<string, GoalSubcommand | undefined> = {
  set: 'set',
  show: 'show',
  pause: 'pause',
  resume: 'resume',
  drop: 'drop',
  clear: 'clear',
};

/**
 * Validated rather than asserted: the argument comes straight from the user,
 * so an unknown word has to be handled, not cast into a union.
 */
function normalizeSubcommand(
  raw: string | undefined,
): GoalSubcommand | 'unknown' {
  return GOAL_SUBCOMMANDS[raw || 'show'] ?? 'unknown';
}

/**
 * A command's output is returned, never pushed onto the UI directly. Adding
 * history items from in here races the session's own pending item: the user's
 * input gets dropped and the previous turn's output reappears. The processor
 * owns that bookkeeping.
 */
function say(content: string, messageType: 'info' | 'error' = 'info') {
  return { type: 'message', messageType, content } as const;
}

function goalConfig(context: CommandContext) {
  const config = context.services.agentContext?.config;
  if (!config) {
    debugLogger.debug('Goal command: config is not available in context');
  }
  return config;
}

/**
 * `/goal` sets and inspects the session goal, which the model is then told to
 * work toward. Any text that is not a subcommand is the objective, so
 * `/goal fix the flaky test` is the normal form.
 *
 * `set` is deliberately not declared as a subCommand. `parseSlashCommand`
 * walks the input path and consumes every subCommand it matches, so declaring
 * it would strip it out of `args` before this function ever ran.
 */
export const goalCommand: SlashCommand = {
  name: 'goal',
  description:
    'Set a goal for this session, with an optional token limit the model is held to',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  // Usable mid-task: changing the goal while the model works is the point.
  isSafeConcurrent: true,
  action: async (context, args) => {
    const config = goalConfig(context);
    if (!config) {
      return say('No active session.', 'error');
    }
    const runtime = config.getGoalRuntime();

    const trimmed = (args ?? '').trim();
    const [firstWord, ...rest] = trimmed ? trimmed.split(/\s+/) : [];
    const subcommand = normalizeSubcommand(firstWord);
    const isGoalText = subcommand === 'unknown' && trimmed.length > 0;

    if (subcommand === 'set' || isGoalText) {
      const words = subcommand === 'set' ? rest : [trimmed];
      // A trailing bare integer is a limit, so an objective that happens to
      // end in a number is not mistaken for one.
      const last = words[words.length - 1];
      const hasLimit = words.length > 1 && /^\d+$/.test(last ?? '');
      const objective = (hasLimit ? words.slice(0, -1) : words)
        .join(' ')
        .trim();

      if (!objective) {
        return say(`Usage: /goal <objective> [token limit]. ${BUDGET_HINT}`);
      }

      try {
        // No limit unless one is asked for. A goal meant to get done should
        // not be cut off by a ceiling nobody chose.
        const goal = runtime.create(
          objective,
          hasLimit ? Number(last) : undefined,
        );
        // No follow-up turn is submitted: the objective reaches the model in
        // the system prompt of whatever you send next, and firing a turn the
        // user did not ask for is a surprising way to spend their tokens.
        return say(
          `Goal set: ${goal.objective}` +
            (goal.tokenBudget === undefined
              ? ' (no token limit)'
              : ` (limit: ${goal.tokenBudget} tokens)`),
        );
      } catch (error) {
        return say(
          error instanceof Error ? error.message : String(error),
          'error',
        );
      }
    }

    try {
      switch (subcommand) {
        case 'show': {
          const goal = runtime.getGoal();
          if (!goal) {
            return say(`No goal is active. ${BUDGET_HINT}`);
          }
          const remaining = remainingTokens(goal);
          return say(
            `${goal.objective}\n` +
              `Status: ${goal.status}\n` +
              `Tokens: ${goal.tokensUsed}` +
              (goal.tokenBudget === undefined
                ? ' (no limit)\n'
                : ` of ${goal.tokenBudget} (${remaining} left)\n`) +
              `Time: ${goal.timeUsedSeconds}s`,
          );
        }
        case 'pause':
          return say(`Goal paused: ${runtime.pause().objective}`);
        case 'resume':
          return say(`Goal resumed: ${runtime.resume().objective}`);
        case 'drop':
          return say(`Goal dropped: ${runtime.drop().objective}`);
        case 'clear': {
          // Completing and dropping both end the goal; `clear` is the
          // neutral word for a user who does not want to claim it was met.
          const goal = runtime.getGoal();
          if (!goal) {
            return say(`No goal is active. ${BUDGET_HINT}`);
          }
          runtime.drop();
          return say(`Goal cleared: ${goal.objective}`);
        }
        default:
          return say(
            `Unknown subcommand "${firstWord}". Use show, pause, resume, drop, clear, or just type the objective.`,
            'error',
          );
      }
    } catch (error) {
      coreEvents.emitFeedback('warning', 'Goal command failed.');
      return say(
        error instanceof Error ? error.message : String(error),
        'error',
      );
    }
  },
  subCommands: [
    {
      name: 'show',
      description: 'Show the current goal and its budget',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      takesArgs: false,
    },
    {
      name: 'pause',
      description: 'Pause the goal so it stops accruing tokens',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      takesArgs: false,
    },
    {
      name: 'resume',
      description: 'Resume a paused goal',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      takesArgs: false,
    },
    {
      name: 'drop',
      description: 'Abandon the goal',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      takesArgs: false,
    },
    {
      name: 'clear',
      description: 'End the goal without claiming it was met',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      takesArgs: false,
    },
  ],
};
