/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  type ExecuteOptions,
  Kind,
  type ToolResult,
} from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { Config } from '../config/config.js';
import {
  GOAL_PARAM_OBJECTIVE,
  GOAL_PARAM_OP,
  GOAL_PARAM_TOKEN_BUDGET,
  GOAL_TOOL_NAME,
} from './definitions/base-declarations.js';
import type { ToolDefinition } from './definitions/types.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
import {
  completionBudgetReport,
  remainingTokens,
  renderGoalPrompt,
  validateTokenBudget,
} from '../goals/runtime.js';
import type { Goal } from '../goals/types.js';

export type GoalOp = 'create' | 'get' | 'complete' | 'drop';

export interface GoalParams {
  op?: string;
  objective?: string;
  token_budget?: number;
}

export const GOAL_DEFINITION: ToolDefinition = {
  base: {
    name: GOAL_TOOL_NAME,
    description:
      'Track a long-running objective for this session. Use op=create to set a goal (optionally with a token_budget, after which you will be told to stop), op=complete when the objective is met, and op=drop to abandon it. Use op=get to check the current goal and its budget.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [GOAL_PARAM_OP]: {
          type: 'string',
          enum: ['create', 'get', 'complete', 'drop'],
          description: 'Goal operation.',
        },
        [GOAL_PARAM_OBJECTIVE]: {
          type: 'string',
          description: 'What the goal is, in one concrete sentence.',
        },
        [GOAL_PARAM_TOKEN_BUDGET]: {
          type: 'integer',
          description:
            'Optional token ceiling for the goal. When it is reached you will be told to stop and wrap up.',
        },
      },
      required: [GOAL_PARAM_OP],
    },
  },
};

function describeGoal(goal: Goal): string {
  const budget =
    goal.tokenBudget === undefined
      ? 'no token budget'
      : `${goal.tokensUsed} of ${goal.tokenBudget} tokens used`;
  return `"${goal.objective}" (${goal.status}, ${budget})`;
}

/** The text shown to the user and returned to the model for a given op. */
function renderResult(op: GoalOp, goal: Goal | null): string {
  if (!goal) {
    return 'No goal is active.';
  }
  switch (op) {
    case 'create':
      return `Goal set to ${describeGoal(goal)}.`;
    case 'get':
      return `Current goal: ${describeGoal(goal)}.`;
    case 'complete': {
      const report = completionBudgetReport(goal);
      return report ?? `Goal completed: ${describeGoal(goal)}.`;
    }
    case 'drop':
      return `Goal dropped: ${describeGoal(goal)}.`;
    default:
      throw new Error(`unknown goal op: ${op satisfies never}`);
  }
}

export class GoalTool extends BaseDeclarativeTool<GoalParams, ToolResult> {
  static readonly Name = GOAL_TOOL_NAME;

  constructor(
    private config: Config,
    messageBus: MessageBus,
  ) {
    super(
      GoalTool.Name,
      'Goal',
      GOAL_DEFINITION.base.description!,
      Kind.Think,
      GOAL_DEFINITION.base.parametersJsonSchema,
      messageBus,
    );
  }

  protected createInvocation(
    params: GoalParams,
    messageBus: MessageBus,
    toolName: string,
    toolDisplayName: string,
  ): GoalInvocation {
    return new GoalInvocation(
      params,
      messageBus,
      toolName,
      toolDisplayName,
      this.config,
    );
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(GOAL_DEFINITION, modelId);
  }
}

export class GoalInvocation extends BaseToolInvocation<GoalParams, ToolResult> {
  constructor(
    params: GoalParams,
    messageBus: MessageBus,
    toolName: string,
    toolDisplayName: string,
    private config: Config,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    const op = this.params[GOAL_PARAM_OP];
    const objective = this.params[GOAL_PARAM_OBJECTIVE];
    if (op === 'create' && objective) {
      return `Setting goal: ${objective}`;
    }
    return `goal ${op ?? '(no op)'}`;
  }

  async execute({ abortSignal: _signal }: ExecuteOptions): Promise<ToolResult> {
    const runtime = this.config.getGoalRuntime();
    const requested = this.params[GOAL_PARAM_OP];

    let op: GoalOp;
    switch (requested) {
      case 'create':
      case 'get':
      case 'complete':
      case 'drop':
        op = requested;
        break;
      default:
        throw new Error(
          `op must be one of create, get, complete, drop; got "${requested}"`,
        );
    }

    try {
      switch (op) {
        case 'create': {
          const objective = this.params[GOAL_PARAM_OBJECTIVE]?.trim();
          if (!objective) {
            throw new Error('objective is required when op=create');
          }
          const tokenBudget = this.params[GOAL_PARAM_TOKEN_BUDGET];
          validateTokenBudget(tokenBudget);
          const goal = runtime.create(objective, tokenBudget);
          return {
            llmContent: `${renderResult('create', goal)}\n\n${renderGoalPrompt('active', goal)}`,
            returnDisplay: renderResult('create', goal),
          };
        }
        case 'get': {
          const goal = runtime.getGoal();
          const remaining = remainingTokens(goal);
          return {
            llmContent: `${renderResult('get', goal)}${
              remaining === null ? '' : ` ${remaining} tokens left.`
            }`,
            returnDisplay: renderResult('get', goal),
          };
        }
        case 'complete': {
          const goal = runtime.complete();
          return {
            llmContent: renderResult('complete', goal),
            returnDisplay: renderResult('complete', goal),
          };
        }
        case 'drop': {
          const goal = runtime.drop();
          return {
            llmContent: renderResult('drop', goal),
            returnDisplay: renderResult('drop', goal),
          };
        }
        default:
          throw new Error(`unhandled goal op: ${op satisfies never}`);
      }
    } catch (error) {
      // Thrown rather than returned: the model asked for something impossible
      // (a second goal, completing a dropped one) and needs to correct itself.
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }
}
