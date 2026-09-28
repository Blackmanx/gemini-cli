/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ExecuteOptions,
  type PolicyUpdateOptions,
  type ToolConfirmationOutcome,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import {
  MEMORY_EDIT_TOOL_NAME,
  MEMORY_RECALL_TOOL_NAME,
  MEMORY_RETAIN_TOOL_NAME,
  MEMORY_REFLECT_TOOL_NAME,
  type MemoryBackend,
  type MemoryEditOp,
  type MemoryEditPatch,
  type MemoryRetainItem,
  type MemoryScope,
  type MemorySearchHit,
} from '../memory/types.js';
import { getErrorMessage } from '../utils/errors.js';
import type { Config } from '../config/config.js';

/**
 * The four tools over the memory bank.
 *
 * Ported from omp's `retain` / `recall` / `reflect` / `memory_edit`. They
 * exist so the agent can write down what it learned and get it back, instead
 * of re-deriving it every session — the thing a coding agent most often
 * wastes turns on.
 *
 * All four are read-tier from the approval engine's point of view except
 * `retain` and `memory_edit`, which write to the bank. None of them touch the
 * user's workspace.
 */

export interface RetainParams {
  items: MemoryRetainItem[];
}

export interface RecallParams {
  query: string;
  limit?: number;
  include_global?: boolean;
}

export interface ReflectParams {
  query: string;
  context?: string;
}

export interface MemoryEditParams {
  op: MemoryEditOp;
  id: string;
  content?: string;
  importance?: number;
}

function formatHits(hits: MemorySearchHit[]): string {
  if (hits.length === 0) return 'No relevant memories found.';
  return [
    `Found ${hits.length} relevant memor${hits.length === 1 ? 'y' : 'ies'}:`,
    '',
    ...hits.map(
      (hit) =>
        `[${hit.id}] (${hit.store}, ${hit.scope}) ${hit.content}` +
        (hit.context ? `\n    context: ${hit.context}` : ''),
    ),
  ].join('\n');
}

function memoryError(message: string): ToolResult {
  return {
    llmContent: message,
    returnDisplay: message,
    error: { message, type: ToolErrorType.MEMORY_TOOL_EXECUTION_ERROR },
  };
}

class RetainInvocation extends BaseToolInvocation<RetainParams, ToolResult> {
  constructor(
    private readonly backend: MemoryBackend,
    private readonly cwd: string,
    private readonly sessionId: string | undefined,
    params: RetainParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  override getDescription(): string {
    return `retain ${this.params.items.length} item(s)`;
  }

  override getPolicyUpdateOptions(
    _outcome: ToolConfirmationOutcome,
  ): PolicyUpdateOptions | undefined {
    return { argsPattern: '"retain"' };
  }

  async execute(_options: ExecuteOptions): Promise<ToolResult> {
    try {
      const result = await this.backend.retain(this.params.items, {
        cwd: this.cwd,
        sessionId: this.sessionId,
      });
      return {
        llmContent: `${result.stored} memor${result.stored === 1 ? 'y' : 'ies'} stored.`,
        returnDisplay: `Stored ${result.stored} memor${result.stored === 1 ? 'y' : 'ies'}.`,
      };
    } catch (err) {
      return memoryError(getErrorMessage(err));
    }
  }
}

class RecallInvocation extends BaseToolInvocation<RecallParams, ToolResult> {
  constructor(
    private readonly backend: MemoryBackend,
    private readonly cwd: string,
    params: RecallParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  override getDescription(): string {
    return `recall "${this.params.query}"`;
  }

  async execute(options: ExecuteOptions): Promise<ToolResult> {
    try {
      const hits = await this.backend.recall(
        this.params.query,
        {
          cwd: this.cwd,
          limit: this.params.limit,
          includeGlobal: this.params.include_global,
        },
        options.abortSignal,
      );
      // An empty recall is a legitimate answer, not a failure: punishing the
      // model for asking makes it ask less.
      return { llmContent: formatHits(hits), returnDisplay: formatHits(hits) };
    } catch (err) {
      return memoryError(getErrorMessage(err));
    }
  }
}

class ReflectInvocation extends BaseToolInvocation<ReflectParams, ToolResult> {
  constructor(
    private readonly backend: MemoryBackend,
    private readonly cwd: string,
    params: ReflectParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  override getDescription(): string {
    return `reflect "${this.params.query}"`;
  }

  async execute(options: ExecuteOptions): Promise<ToolResult> {
    try {
      const composed = this.params.context
        ? `${this.params.query}\n\nAdditional context:\n${this.params.context}`
        : this.params.query;
      const hits = await this.backend.recall(
        composed,
        { cwd: this.cwd, limit: 10, includeGlobal: true },
        options.abortSignal,
      );
      if (hits.length === 0) {
        return {
          llmContent:
            'Nothing in the memory bank bears on that question. Answer from the code instead.',
          returnDisplay: 'No relevant memories.',
        };
      }
      const body = hits
        .map(
          (hit) => `- ${hit.content}${hit.context ? ` (${hit.context})` : ''}`,
        )
        .join('\n');
      const text = `Based on recalled memories:\n\n${body}`;
      return { llmContent: text, returnDisplay: text };
    } catch (err) {
      return memoryError(getErrorMessage(err));
    }
  }
}

class MemoryEditInvocation extends BaseToolInvocation<
  MemoryEditParams,
  ToolResult
> {
  constructor(
    private readonly backend: MemoryBackend,
    private readonly cwd: string,
    params: MemoryEditParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  override getDescription(): string {
    return `memory_edit ${this.params.op} ${this.params.id}`;
  }

  override getPolicyUpdateOptions(
    _outcome: ToolConfirmationOutcome,
  ): PolicyUpdateOptions | undefined {
    return { argsPattern: `"${this.params.id}"` };
  }

  async execute(_options: ExecuteOptions): Promise<ToolResult> {
    const { op, id, content, importance } = this.params;
    // An update that changes nothing would report success while doing nothing.
    if (op === 'update' && content === undefined && importance === undefined) {
      return memoryError(
        'An update needs `content` or `importance`; use forget or invalidate to remove a memory.',
      );
    }
    const patch: MemoryEditPatch | undefined =
      op === 'update' ? { content, importance } : undefined;
    try {
      const status = await this.backend.edit(op, id, patch, { cwd: this.cwd });
      const text =
        status === 'not_found'
          ? `No memory with id ${id}. Use recall to list what is stored.`
          : status === 'not_editable'
            ? `Memory ${id} is a derived projection and cannot be edited. ` +
              'Edit or forget the memories it was derived from instead.'
            : `Memory ${id}: ${status}.`;
      if (status === 'not_found' || status === 'not_editable') {
        return memoryError(text);
      }
      return { llmContent: text, returnDisplay: text };
    } catch (err) {
      return memoryError(getErrorMessage(err));
    }
  }
}

/** Store durable facts about this project for future sessions. */
export class RetainTool extends BaseDeclarativeTool<RetainParams, ToolResult> {
  static readonly Name = MEMORY_RETAIN_TOOL_NAME;

  constructor(
    private readonly backend: MemoryBackend,
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      RetainTool.Name,
      'Retain',
      'Store durable facts about this codebase so a later session starts with them. Use it for what the code does not say: why a choice was made, what is load-bearing, which approach was already tried and rejected. Do not store anything the repository already records.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            description: 'The facts to store.',
            items: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  description:
                    'A self-contained statement that will still be true next month.',
                },
                context: {
                  type: 'string',
                  description: 'Where this came from, in one line.',
                },
                scope: {
                  type: 'string',
                  enum: ['project', 'global'],
                  description:
                    '`project` (default) keeps the fact with this repo; `global` applies everywhere.',
                },
              },
              required: ['content'],
            },
          },
        },
        required: ['items'],
      },
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: RetainParams,
  ): string | null {
    if (!Array.isArray(params.items) || params.items.length === 0) {
      return 'items must be a non-empty array.';
    }
    for (const [index, item] of params.items.entries()) {
      if (
        !item ||
        typeof item.content !== 'string' ||
        item.content.trim() === ''
      ) {
        return `items[${index}].content must be a non-empty string.`;
      }
      if (
        item.scope !== undefined &&
        item.scope !== 'project' &&
        item.scope !== 'global'
      ) {
        return `items[${index}].scope must be 'project' or 'global'.`;
      }
    }
    return null;
  }

  protected createInvocation(
    params: RetainParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<RetainParams, ToolResult> {
    return new RetainInvocation(
      this.backend,
      this.config.getTargetDir(),
      undefined,
      params,
      messageBus,
      toolName ?? this.name,
      toolDisplayName ?? this.displayName,
    );
  }
}

/** Search what earlier sessions retained. */
export class RecallTool extends BaseDeclarativeTool<RecallParams, ToolResult> {
  static readonly Name = MEMORY_RECALL_TOOL_NAME;

  constructor(
    private readonly backend: MemoryBackend,
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      RecallTool.Name,
      'Recall',
      'Search the memory bank for what previous sessions learned. Use a natural-language question, not keywords.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you want to know.' },
          limit: {
            type: 'integer',
            minimum: 1,
            description: 'Maximum results. Defaults to 20.',
          },
          include_global: {
            type: 'boolean',
            description: 'Also search facts stored for every project.',
          },
        },
        required: ['query'],
      },
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: RecallParams,
  ): string | null {
    if (!params.query || params.query.trim() === '') {
      return 'query must be a non-empty string.';
    }
    if (params.limit !== undefined && params.limit < 1) {
      return 'limit must be at least 1.';
    }
    return null;
  }

  protected createInvocation(
    params: RecallParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<RecallParams, ToolResult> {
    return new RecallInvocation(
      this.backend,
      this.config.getTargetDir(),
      params,
      messageBus,
      toolName ?? this.name,
      toolDisplayName ?? this.displayName,
    );
  }
}

/** Answer a question from the memory bank. */
export class ReflectTool extends BaseDeclarativeTool<
  ReflectParams,
  ToolResult
> {
  static readonly Name = MEMORY_REFLECT_TOOL_NAME;

  constructor(
    private readonly backend: MemoryBackend,
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      ReflectTool.Name,
      'Reflect',
      'Answer a question from what the memory bank already knows, so you do not re-derive it. This retrieves and presents; it does not reason for you.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The question to answer.' },
          context: {
            type: 'string',
            description: 'What you are trying to do, which narrows the answer.',
          },
        },
        required: ['query'],
      },
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: ReflectParams,
  ): string | null {
    if (!params.query || params.query.trim() === '') {
      return 'query must be a non-empty string.';
    }
    return null;
  }

  protected createInvocation(
    params: ReflectParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<ReflectParams, ToolResult> {
    return new ReflectInvocation(
      this.backend,
      this.config.getTargetDir(),
      params,
      messageBus,
      toolName ?? this.name,
      toolDisplayName ?? this.displayName,
    );
  }
}

/** Correct, forget or invalidate a stored memory. */
export class MemoryEditTool extends BaseDeclarativeTool<
  MemoryEditParams,
  ToolResult
> {
  static readonly Name = MEMORY_EDIT_TOOL_NAME;

  constructor(
    private readonly backend: MemoryBackend,
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      MemoryEditTool.Name,
      'Memory Edit',
      'Correct or remove a memory that is wrong, superseded, or no longer true. This is the only way to fix a bad memory without hand-editing files.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['update', 'forget', 'invalidate'],
            description:
              'update rewrites it; forget deletes it; invalidate keeps it for provenance but drops it from recall.',
          },
          id: {
            type: 'string',
            description: 'The memory id, as returned by recall.',
          },
          content: {
            type: 'string',
            description:
              'Replacement content. Required for a meaningful update.',
          },
          importance: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'How much this should be weighted, 0 to 1.',
          },
        },
        required: ['op', 'id'],
      },
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: MemoryEditParams,
  ): string | null {
    if (!params.id || params.id.trim() === '') {
      return 'id must be a non-empty string.';
    }
    if (!['update', 'forget', 'invalidate'].includes(params.op)) {
      return "op must be 'update', 'forget' or 'invalidate'.";
    }
    return null;
  }

  protected createInvocation(
    params: MemoryEditParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<MemoryEditParams, ToolResult> {
    return new MemoryEditInvocation(
      this.backend,
      this.config.getTargetDir(),
      params,
      messageBus,
      toolName ?? this.name,
      toolDisplayName ?? this.displayName,
    );
  }
}

export type { MemoryScope };
