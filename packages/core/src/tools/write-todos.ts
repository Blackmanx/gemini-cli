/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type Todo,
  type ToolResult,
  type ExecuteOptions,
} from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { WRITE_TODOS_TOOL_NAME } from './tool-names.js';
import { WRITE_TODOS_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';

const TODO_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
  'blocked',
] as const;

export interface WriteTodosToolParams {
  /**
   * The full list of todos. This will overwrite any existing list.
   *
   * Mutually exclusive with `phases`. Ordered operations are NOT supported:
   * this tool keeps no server-side state, so a verb like "mark item 2 done"
   * has nothing to apply it to. The list is replaced, and the model re-sends
   * it. A second source of truth for the list would let the UI and the model
   * drift apart, which is worse than re-sending a few lines.
   */
  todos?: Todo[];
  /**
   * The list grouped into named phases, in order. Use this when the work has
   * distinct stages, so progress reads as "phase 2 of 4" rather than a flat
   * list the model has to re-derive the structure of on every update.
   */
  phases?: TodoPhase[];
}

/** A named group of todos. */
export interface TodoPhase {
  name: string;
  todos: Todo[];
}

class WriteTodosToolInvocation extends BaseToolInvocation<
  WriteTodosToolParams,
  ToolResult
> {
  constructor(
    params: WriteTodosToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const todos = this.#flattened();
    if (todos.length === 0) {
      return 'Cleared todo list';
    }
    return `Set ${todos.length} todo(s)`;
  }

  /**
   * The todos, whether given flat or phased.
   *
   * Both forms are the SAME list to the UI: phases are a grouping for the
   * reader, not a second structure the rest of the app has to understand.
   */
  #flattened(): Todo[] {
    if (this.params.phases !== undefined) {
      return this.params.phases.flatMap((phase) => phase.todos ?? []);
    }
    return this.params.todos ?? [];
  }

  /** A human rendering that keeps the phase headings when there are phases. */
  #rendered(): string {
    const { phases } = this.params;
    if (phases === undefined) {
      return this.#flattened()
        .map(
          (todo, index) => `${index + 1}. [${todo.status}] ${todo.description}`,
        )
        .join('\n');
    }
    let n = 0;
    return phases
      .map((phase) => {
        const items = (phase.todos ?? [])
          .map((todo) => {
            n += 1;
            return `${n}. [${todo.status}] ${todo.description}`;
          })
          .join('\n');
        return items === ''
          ? `${phase.name}\n  (empty)`
          : `${phase.name}\n${items}`;
      })
      .join('\n');
  }

  async execute({ abortSignal: _signal }: ExecuteOptions): Promise<ToolResult> {
    const todos = this.#flattened();

    const llmContent =
      todos.length > 0
        ? `Successfully updated the todo list. The current list is now:\n${this.#rendered()}`
        : 'Successfully cleared the todo list.';

    return {
      llmContent,
      returnDisplay: { todos },
    };
  }
}

export class WriteTodosTool extends BaseDeclarativeTool<
  WriteTodosToolParams,
  ToolResult
> {
  static readonly Name = WRITE_TODOS_TOOL_NAME;

  constructor(messageBus: MessageBus) {
    super(
      WriteTodosTool.Name,
      'WriteTodos',
      WRITE_TODOS_DEFINITION.base.description!,
      Kind.Other,
      WRITE_TODOS_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(WRITE_TODOS_DEFINITION, modelId);
  }

  protected override validateToolParamValues(
    params: WriteTodosToolParams,
  ): string | null {
    const { todos: flat, phases } = params ?? {};
    // `todos` and `phases` are two renderings of ONE list, not two lists.
    // Accepting both would make it ambiguous which one the UI is showing.
    if (flat !== undefined && phases !== undefined) {
      return 'Provide either `todos` or `phases`, not both.';
    }
    if (phases !== undefined) {
      if (!Array.isArray(phases)) {
        return '`phases` parameter must be an array';
      }
      for (const [index, phase] of phases.entries()) {
        if (typeof phase !== 'object' || phase === null) {
          return `Each phase must be an object (phases[${index}])`;
        }
        if (typeof phase.name !== 'string' || !phase.name.trim()) {
          return `Each phase needs a non-empty name (phases[${index}])`;
        }
        if (!Array.isArray(phase.todos)) {
          return `Each phase needs a \`todos\` array (phases[${index}])`;
        }
      }
    }
    const todos = phases === undefined ? flat : phases.flatMap((p) => p.todos);
    if (todos === undefined) {
      return 'Provide a `todos` array or a `phases` array.';
    }
    if (!Array.isArray(todos)) {
      return '`todos` parameter must be an array';
    }

    for (const todo of todos) {
      if (typeof todo !== 'object' || todo === null) {
        return 'Each todo item must be an object';
      }
      if (typeof todo.description !== 'string' || !todo.description.trim()) {
        return 'Each todo must have a non-empty description string';
      }
      if (!TODO_STATUSES.includes(todo.status)) {
        return `Each todo must have a valid status (${TODO_STATUSES.join(', ')})`;
      }
    }

    const inProgressCount = todos.filter(
      (todo: Todo) => todo.status === 'in_progress',
    ).length;

    if (inProgressCount > 1) {
      return 'Invalid parameters: Only one task can be "in_progress" at a time.';
    }

    return null;
  }

  protected createInvocation(
    params: WriteTodosToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _displayName?: string,
  ): ToolInvocation<WriteTodosToolParams, ToolResult> {
    return new WriteTodosToolInvocation(
      params,
      messageBus,
      _toolName,
      _displayName,
    );
  }
}
