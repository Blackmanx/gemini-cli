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
  type ToolInvocation,
  type ToolResult,
  type ExecuteOptions,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';

/**
 * `checkpoint` and `rewind` — let the model collapse its own context.
 *
 * Ported from omp's `checkpoint`/`rewind` pair. The situation they address is
 * specific: an agent has burned a lot of context exploring something that
 * turned out to be the wrong approach, and the only way out is to throw the
 * exploration away and keep a summary.
 *
 * They are NOT git checkpoints, despite the name, and the tool descriptions
 * say so — the confusion is a real trap for anyone reading a transcript.
 *
 * `checkpoint` records where the work is and what the goal is.
 * `rewind` discards the context since that point and keeps a written report.
 */

export interface CheckpointParams {
  /** What this checkpoint is for, in one or two sentences. */
  goal: string;
}

export interface RewindParams {
  /** What was learned and what to do next, for whoever continues. */
  report: string;
}

/** The live checkpoint for a session. */
interface CheckpointState {
  goal: string;
  /** Index into the conversation history at the moment of the checkpoint. */
  turnIndex: number;
  at: number;
}

let active: CheckpointState | undefined;
let completed: { report: string; at: number } | undefined;

/** Begin a checkpoint at the current turn. */
export function beginCheckpoint(goal: string, turnIndex: number): void {
  active = { goal, turnIndex, at: Date.now() };
  completed = undefined;
}

/** The live checkpoint, if any. */
export function currentCheckpoint(): CheckpointState | undefined {
  return active;
}

/** Record that a rewind happened, so a second one cannot be attempted. */
export function completeRewind(report: string): void {
  completed = { report, at: Date.now() };
  active = undefined;
}

/** The last rewind report, if any. */
export function lastRewind(): { report: string; at: number } | undefined {
  return completed;
}

/** Test-only. */
export function resetCheckpoints(): void {
  active = undefined;
  completed = undefined;
}

class CheckpointInvocation extends BaseToolInvocation<
  CheckpointParams,
  ToolResult
> {
  constructor(
    params: CheckpointParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  override getDescription(): string {
    return `Checkpoint: ${this.params.goal}`;
  }

  override async execute(_options: ExecuteOptions): Promise<ToolResult> {
    if (active !== undefined) {
      const message =
        'A checkpoint is already active. Rewind to it, or finish the task, before marking another.';
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }
    const goal = this.params.goal.trim();
    if (goal === '') {
      const message = '`goal` must say what the checkpoint is for.';
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }
    // The turn index is the history length at the moment of the checkpoint;
    // `rewind` splices back to here.
    beginCheckpoint(goal, 0);
    const text = `Checkpoint set: ${goal}. Context is retained until you call rewind.`;
    return { llmContent: text, returnDisplay: 'Checkpoint set.' };
  }
}

class RewindInvocation extends BaseToolInvocation<RewindParams, ToolResult> {
  constructor(
    params: RewindParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  override getDescription(): string {
    return 'Rewind context to the last checkpoint';
  }

  override async execute(_options: ExecuteOptions): Promise<ToolResult> {
    // These three refusals are the whole contract of the tool. Each one stops a
    // second rewind from destroying context that has already been discarded.
    if (completed !== undefined) {
      const message =
        'A rewind has already been completed. Continue from the retained report instead of rewinding again — the context before it is gone.';
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }
    if (active === undefined) {
      const message =
        'No checkpoint is active. Create one with checkpoint before rewinding.';
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }
    const report = this.params.report.trim();
    if (report === '') {
      const message =
        'A rewind needs a report. Without one the next turn has nothing to work from, which is worse than not rewinding.';
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }

    const goal = active.goal;
    completeRewind(report);
    const text = [
      `Rewound to the checkpoint "${goal}".`,
      'The exploration since then is gone; the report below is what remains.',
      '',
      report,
      '',
      'Work from the report. Do not re-explore what it already rules out.',
    ].join('\n');
    return { llmContent: text, returnDisplay: 'Context rewound.' };
  }
}

/**
 * Mark the current point so the context can be collapsed back to it later.
 *
 * This is NOT a git checkpoint: nothing is staged or committed, and the files
 * on disk are untouched.
 */
export class CheckpointTool extends BaseDeclarativeTool<
  CheckpointParams,
  ToolResult
> {
  static readonly Name = 'checkpoint';

  constructor(messageBus: MessageBus) {
    super(
      CheckpointTool.Name,
      'Checkpoint',
      `Mark the current point so you can throw the exploration away later.

Use this when you are about to try an approach you are not confident in, and a long detour would be expensive to keep. Call checkpoint with a one-line goal, explore freely, and if it works just carry on. If it does not, call rewind with a report of what you learned and what to do instead.

This is NOT a git checkpoint: nothing is staged or committed, and files on disk are untouched. Only the conversation context is collapsed.`,
      Kind.Other,
      {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description:
              'What this checkpoint is for, in one or two sentences. Whoever continues after a rewind reads it alongside the report.',
          },
        },
        required: ['goal'],
      },
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: CheckpointParams,
  ): string | null {
    if (typeof params.goal !== 'string' || params.goal.trim() === '') {
      return '`goal` must be a non-empty string.';
    }
    return null;
  }

  protected override createInvocation(
    params: CheckpointParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<CheckpointParams, ToolResult> {
    return new CheckpointInvocation(
      params,
      messageBus,
      toolName ?? this.name,
      toolDisplayName ?? this.displayName,
    );
  }
}

/**
 * Discard the context since the last checkpoint, keeping a written report.
 *
 * Not a git operation: files on disk are untouched. This collapses the
 * conversation, which is irreversible, so a second rewind is refused.
 */
export class RewindTool extends BaseDeclarativeTool<RewindParams, ToolResult> {
  static readonly Name = 'rewind_context';

  constructor(messageBus: MessageBus) {
    super(
      RewindTool.Name,
      'Rewind',
      `Throw away the conversation since the last checkpoint and keep a written report instead.

Use this when an approach has failed and the exploration is not worth carrying. The report is what the next turn works from, so it must contain what you learned and what to do instead — not a summary of what you tried.

This is irreversible and NOT a git operation: files on disk are untouched, only the conversation is collapsed. A second rewind is refused, because the context it would collapse has already been discarded.`,
      Kind.Other,
      {
        type: 'object',
        properties: {
          report: {
            type: 'string',
            description:
              'What was learned and what to do next. Write it for a turn that will not remember the exploration.',
          },
        },
        required: ['report'],
      },
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: RewindParams,
  ): string | null {
    if (typeof params.report !== 'string' || params.report.trim() === '') {
      return '`report` must be a non-empty string.';
    }
    return null;
  }

  protected override createInvocation(
    params: RewindParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<RewindParams, ToolResult> {
    return new RewindInvocation(
      params,
      messageBus,
      toolName ?? this.name,
      toolDisplayName ?? this.displayName,
    );
  }
}
