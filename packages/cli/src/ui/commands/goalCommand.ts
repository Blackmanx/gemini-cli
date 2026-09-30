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
import { MessageType } from '../types.js';

type GoalSubcommand = 'set' | 'show' | 'pause' | 'resume' | 'drop' | 'clear';

const BUDGET_HINT = 'Use `/goal set <objective> [tokens]` to set one.';

function goalConfig(context: CommandContext) {
  const config = context.services.agentContext?.config;
  if (!config) {
    debugLogger.debug('Goal command: config is not available in context');
  }
  return config;
}

function report(context: CommandContext, text: string) {
  context.ui.addItem({ type: MessageType.INFO, text });
}

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
 * `/goal` sets and inspects the session goal, which the model is then told to
 * work toward. A goal may carry a token budget; when it runs out the model is
 * steered to stop rather than left to keep spending.
 */
export const goalCommand: SlashCommand = {
  name: 'goal',
  description:
    'Set a goal for this session, with an optional token budget the model is held to',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  // Usable mid-task: changing the goal while the model works is the point.
  isSafeConcurrent: true,
  action: async (context, args) => {
    const config = goalConfig(context);
    if (!config) {
      return;
    }
    const runtime = config.getGoalRuntime();
    const [rawSubcommand, ...rest] = (args ?? '').trim().split(/\s+/);
    const subcommand = normalizeSubcommand(rawSubcommand);

    try {
      switch (subcommand) {
        case 'set': {
          // The budget is the last argument and must be a bare integer, so an
          // objective ending in a number is not mistaken for one.
          const last = rest[rest.length - 1];
          const hasBudget = rest.length > 0 && /^\d+$/.test(last ?? '');
          const objective = (hasBudget ? rest.slice(0, -1) : rest)
            .join(' ')
            .trim();
          if (!objective) {
            report(
              context,
              'Usage: /goal set <objective> [token budget]. ' + BUDGET_HINT,
            );
            return;
          }
          const tokenBudget = hasBudget ? Number(last) : undefined;
          const goal = runtime.create(objective, tokenBudget);
          report(
            context,
            `Goal set: ${goal.objective}` +
              (goal.tokenBudget === undefined
                ? ' (no token budget)'
                : ` (budget: ${goal.tokenBudget} tokens)`),
          );
          return { type: 'submit_prompt', content: 'Check your current goal.' };
        }
        case 'show': {
          const goal = runtime.getGoal();
          if (!goal) {
            report(context, `No goal is active. ${BUDGET_HINT}`);
            return;
          }
          const remaining = remainingTokens(goal);
          report(
            context,
            `${goal.objective}\n` +
              `Status: ${goal.status}\n` +
              `Tokens: ${goal.tokensUsed}` +
              (goal.tokenBudget === undefined
                ? ' (no budget)\n'
                : ` of ${goal.tokenBudget} (${remaining} left)\n`) +
              `Time: ${goal.timeUsedSeconds}s`,
          );
          return;
        }
        case 'pause': {
          report(context, `Goal paused: ${runtime.pause().objective}`);
          return;
        }
        case 'resume': {
          report(context, `Goal resumed: ${runtime.resume().objective}`);
          return { type: 'submit_prompt', content: 'Continue with the goal.' };
        }
        case 'drop': {
          report(context, `Goal dropped: ${runtime.drop().objective}`);
          return;
        }
        case 'clear': {
          // Completing and dropping both end the goal; `clear` is the
          // neutral word for a user who does not want to claim it was met.
          const goal = runtime.getGoal();
          if (!goal) {
            report(context, `No goal is active. ${BUDGET_HINT}`);
            return;
          }
          runtime.drop();
          report(context, `Goal cleared: ${goal.objective}`);
          return;
        }
        default:
          report(
            context,
            `Unknown subcommand "${subcommand}". Use set, show, pause, resume, drop or clear.`,
          );
          return;
      }
    } catch (error) {
      report(context, error instanceof Error ? error.message : String(error));
      coreEvents.emitFeedback(
        'warning',
        'Goal command failed. Run /goal show to see the current state.',
      );
    }

    return;
  },
  subCommands: [
    {
      name: 'set',
      description:
        'Set the goal for this session: /goal set <objective> [tokens]',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      takesArgs: true,
    },
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
