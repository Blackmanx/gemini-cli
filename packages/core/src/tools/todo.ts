/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ExecuteOptions,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { Config } from '../config/config.js';
import {
  TODO_PARAM_ITEMS,
  TODO_PARAM_LIST,
  TODO_PARAM_OP,
  TODO_PARAM_PHASE,
  TODO_PARAM_REASON,
  TODO_PARAM_TASK,
  TODO_TOOL_NAME,
} from './definitions/base-declarations.js';
import type { ToolDefinition } from './definitions/types.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
import {
  clonePhases,
  formatSummary,
  inferTodoOp,
} from '../todos/operations.js';
import type { TodoParams } from '../todos/types.js';

export const TODO_DEFINITION: ToolDefinition = {
  base: {
    name: TODO_TOOL_NAME,
    description: `Maintain a structured, phase-grouped todo list to track progress on a multi-step task. Tasks are addressed by their verbatim \`content\` text — NEVER by generated IDs. Keep phase and task names unique and stable; to re-read the current list, use op=view rather than guessing.

The list is mutated by small operations rather than being resent whole:
- init: create (or replace) the list. Group into \`list: [{phase, items}]\` when the work has distinct stages, or pass a flat \`items\` array for a single phase. Use this before starting work on a request with 3+ steps, a requested task set, or new instructions. List EVERY user item separately; never omit or batch leftovers.
- start: mark a task in_progress (there is only ever one in_progress task).
- done: mark a task (or every task in a phase) completed.
- drop: abandon a task that is no longer needed.
- block / unblock: mark a task waiting on an external user/agent/service (with an optional \`reason\`), or clear it back to pending.
- rm: remove a task, a whole phase, or the entire list.
- append: add tasks to an existing (or new) phase.
- view: read the current list without changing it.

After a successful mutation the single in_progress pointer auto-advances to the earliest pending task in phase order; completed work is never reopened. Mark a task done as soon as it finishes — don't batch updates. Never call todo alone: init with the first work, then done/start alongside the next action.`,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [TODO_PARAM_OP]: {
          type: 'string',
          enum: [
            'init',
            'start',
            'done',
            'rm',
            'drop',
            'block',
            'unblock',
            'append',
            'view',
          ],
          description: 'The todo operation to perform.',
        },
        [TODO_PARAM_LIST]: {
          type: 'array',
          description:
            'Phases for `init`: each with a name and its task items. Mutually the phased form of `items`.',
          items: {
            type: 'object',
            properties: {
              phase: { type: 'string', description: 'The phase name.' },
              items: {
                type: 'array',
                description: 'Task contents in this phase.',
                items: { type: 'string' },
              },
            },
            required: ['phase', 'items'],
            additionalProperties: false,
          },
        },
        [TODO_PARAM_TASK]: {
          type: 'string',
          description:
            'Verbatim task content used to target a single task (start/done/drop/rm/block/unblock).',
        },
        [TODO_PARAM_PHASE]: {
          type: 'string',
          description:
            'Phase name used to target a whole phase (done/drop/rm/block/unblock), or the target phase for `append`.',
        },
        [TODO_PARAM_ITEMS]: {
          type: 'array',
          description:
            'Task contents for a flat `init`, or tasks to add for `append`.',
          items: { type: 'string' },
        },
        [TODO_PARAM_REASON]: {
          type: 'string',
          description: 'Blocker note for `block`.',
        },
      },
      additionalProperties: false,
    },
  },
};

const VALID_OPS = [
  'init',
  'start',
  'done',
  'rm',
  'drop',
  'block',
  'unblock',
  'append',
  'view',
] as const;

function toParams(raw: Record<string, unknown>): TodoParams {
  return {
    op: raw[TODO_PARAM_OP] as TodoParams['op'],
    list: raw[TODO_PARAM_LIST] as TodoParams['list'],
    task: raw[TODO_PARAM_TASK] as TodoParams['task'],
    phase: raw[TODO_PARAM_PHASE] as TodoParams['phase'],
    items: raw[TODO_PARAM_ITEMS] as TodoParams['items'],
    reason: raw[TODO_PARAM_REASON] as TodoParams['reason'],
  };
}

export class TodoToolInvocation extends BaseToolInvocation<
  Record<string, unknown>,
  ToolResult
> {
  constructor(
    params: Record<string, unknown>,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
    private readonly config?: Config,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    const op = this.params[TODO_PARAM_OP];
    const task = this.params[TODO_PARAM_TASK];
    const phase = this.params[TODO_PARAM_PHASE];
    const parts = [`todo ${op ?? '(auto)'}`];
    if (typeof task === 'string' && task) parts.push(task);
    else if (typeof phase === 'string' && phase) parts.push(phase);
    return parts.join(' ');
  }

  async execute({ abortSignal: _signal }: ExecuteOptions): Promise<ToolResult> {
    const runtime = this.config?.getTodoRuntime();
    const previousPhases = runtime?.getPhases() ?? [];

    // Repair a missing `op` from an unambiguous payload (models routinely send
    // `{list:[...]}` or a bare `{items:[...]}` with no op).
    let rawOp = this.params[TODO_PARAM_OP];
    if (
      (rawOp === undefined || rawOp === null) &&
      (Array.isArray(this.params[TODO_PARAM_LIST]) ||
        Array.isArray(this.params[TODO_PARAM_ITEMS]))
    ) {
      const inferred = inferTodoOp(
        this.params,
        previousPhases.length > 0,
      );
      if (inferred) rawOp = inferred;
    }
    if (
      typeof rawOp !== 'string' ||
      !VALID_OPS.includes(rawOp as TodoParams['op'])
    ) {
      throw new Error(
        `op must be one of ${VALID_OPS.join(', ')}; got "${String(rawOp)}"`,
      );
    }

    const entry: TodoParams = { ...toParams(this.params), op: rawOp as TodoParams['op'] };
    const readOnly = entry.op === 'view';

    if (readOnly || !runtime) {
      const phases = runtime ? previousPhases : clonePhases(previousPhases);
      return {
        llmContent: formatSummary(phases, [], true),
        returnDisplay: { phases, op: entry.op },
      };
    }

    const { phases, errors } = runtime.applyOps([entry]);
    if (errors.length > 0) {
      // A failed op changes nothing; surface every problem so the model can
      // correct itself in one retry.
      throw new Error(errors.join('; '));
    }

    return {
      llmContent: formatSummary(phases, []),
      returnDisplay: { phases, op: entry.op },
    };
  }
}

export class TodoTool extends BaseDeclarativeTool<
  Record<string, unknown>,
  ToolResult
> {
  static readonly Name = TODO_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      TodoTool.Name,
      'Todo',
      TODO_DEFINITION.base.description!,
      Kind.Other,
      TODO_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(TODO_DEFINITION, modelId);
  }

  protected override validateToolParamValues(
    params: Record<string, unknown>,
  ): string | null {
    // All op-specific validation happens in execute so a missing `op` can be
    // repaired from an unambiguous payload before anything is rejected.
    return null;
  }

  protected createInvocation(
    params: Record<string, unknown>,
    messageBus: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<Record<string, unknown>, ToolResult> {
    return new TodoToolInvocation(
      params,
      messageBus,
      toolName,
      displayName,
      this.config,
    );
  }
}
