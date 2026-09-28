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
import { getErrorMessage } from '../utils/errors.js';
import {
  sanitizeManagedDescription,
  writeManagedSkill,
} from '../skills/managedSkills.js';
import type { MemoryBackend, MemoryScope } from '../memory/types.js';
import type { Config } from '../config/config.js';

/**
 * `learn` — capture a durable lesson, and optionally turn it into a skill.
 *
 * Ported from omp's `learn`. The ordering is deliberate: the lesson is stored
 * FIRST and the skill attempt second, so a skill that cannot be written still
 * leaves the lesson behind. Doing it the other way round would lose the
 * lesson whenever the skill half failed, which is exactly when you most want
 * to keep it.
 */

export interface LearnParams {
  /** A self-contained lesson: what, when, and why. */
  memory: string;
  /** Where this came from, in one line. */
  context?: string;
  scope?: MemoryScope;
  skill?: {
    action: 'create' | 'update';
    name: string;
    description: string;
    /** Markdown body, without frontmatter — the store adds it. */
    body: string;
  };
}

const LEARN_DESCRIPTION = `Capture a durable lesson so a later session starts with it.

Use it for something that will still be true next week and that the repository does not already say: why a design choice was made, which approach was tried and rejected, what is load-bearing. Do not use it for anything the code, the tests or the commit history already records.

Pass \`skill\` as well when the lesson is really a procedure worth following rather than a fact worth knowing.`;

class LearnInvocation extends BaseToolInvocation<LearnParams, ToolResult> {
  constructor(
    private readonly backend: MemoryBackend,
    private readonly managedSkillsDir: string,
    private readonly cwd: string,
    private readonly sessionId: string | undefined,
    params: LearnParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  override getDescription(): string {
    return 'learn a lesson';
  }

  override getPolicyUpdateOptions(
    _outcome: ToolConfirmationOutcome,
  ): PolicyUpdateOptions | undefined {
    return this.params.skill === undefined
      ? undefined
      : { argsPattern: '"name"\\s*:\\s*"[^"]+"' };
  }

  override async execute(_options: ExecuteOptions): Promise<ToolResult> {
    const lesson = this.params.memory.trim();
    if (lesson === '') {
      const message = 'A lesson must be a non-empty string.';
      return {
        llmContent: message,
        returnDisplay: 'Nothing learned.',
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }

    // The lesson lands first and unconditionally.
    let stored = 0;
    try {
      const result = await this.backend.retain(
        [
          {
            content: lesson,
            ...(this.params.context === undefined
              ? {}
              : { context: this.params.context }),
            ...(this.params.scope === undefined
              ? {}
              : { scope: this.params.scope }),
          },
        ],
        { cwd: this.cwd, sessionId: this.sessionId },
      );
      stored = result.stored;
    } catch (err) {
      const message = getErrorMessage(err);
      return {
        llmContent: message,
        returnDisplay: 'Lesson not stored.',
        error: { message, type: ToolErrorType.MEMORY_TOOL_EXECUTION_ERROR },
      };
    }

    if (this.params.skill === undefined) {
      const text =
        stored === 1
          ? 'Lesson stored. No skill was requested.'
          : 'Lesson not stored — the memory backend is unavailable.';
      return { llmContent: text, returnDisplay: text };
    }

    // The skill is best-effort. A failure here must not read as "the lesson
    // was lost", so the message says exactly which half succeeded.
    const { action, name, description, body } = this.params.skill;
    try {
      writeManagedSkill(
        this.managedSkillsDir,
        {
          name,
          // A managed description is generated from prior task content and
          // read back in later sessions, so it is sanitized on the way in.
          description: sanitizeManagedDescription(description),
          body,
        },
        action,
      );
      return {
        llmContent: `Lesson stored, and the "${name}" skill was ${action}d. Reload skills to use it.`,
        returnDisplay: `Lesson stored and skill ${action}d.`,
      };
    } catch (err) {
      const message =
        `Lesson stored, but the "${name}" skill could not be written: ` +
        getErrorMessage(err);
      return {
        llmContent: message,
        returnDisplay: 'Lesson stored; skill not written.',
        error: { message, type: ToolErrorType.MEMORY_TOOL_EXECUTION_ERROR },
      };
    }
  }
}

/** Store a durable lesson, optionally minting a managed skill from it. */
export class LearnTool extends BaseDeclarativeTool<LearnParams, ToolResult> {
  static readonly Name = 'learn';

  constructor(
    private readonly backend: MemoryBackend,
    private readonly managedSkillsDir: string,
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      LearnTool.Name,
      'Learn',
      LEARN_DESCRIPTION,
      Kind.Other,
      {
        type: 'object',
        properties: {
          memory: {
            type: 'string',
            description:
              'The lesson itself: what happened, when, and why it matters. Self-contained — the next session will not have this conversation.',
          },
          context: {
            type: 'string',
            description: 'Where this came from, in one line.',
          },
          scope: {
            type: 'string',
            enum: ['project', 'global'],
            description:
              '`project` (default) keeps the lesson with this repo; `global` applies everywhere.',
          },
          skill: {
            type: 'object',
            description: 'Optional: also write the lesson as a reusable skill.',
            properties: {
              action: {
                type: 'string',
                enum: ['create', 'update'],
                description:
                  'Whether the skill is new or replaces an existing one.',
              },
              name: {
                type: 'string',
                description:
                  'Lowercase, digits and dashes only; it becomes a directory name.',
              },
              description: {
                type: 'string',
                description: 'One line: when should this skill be used?',
              },
              body: {
                type: 'string',
                description: 'Markdown body, without frontmatter.',
              },
            },
            required: ['action', 'name', 'description', 'body'],
          },
        },
        required: ['memory'],
      },
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: LearnParams,
  ): string | null {
    if (typeof params.memory !== 'string' || params.memory.trim() === '') {
      return '`memory` must be a non-empty string.';
    }
    if (
      params.scope !== undefined &&
      !['project', 'global'].includes(params.scope)
    ) {
      return "`scope` must be 'project' or 'global'.";
    }
    if (params.skill !== undefined) {
      if (!params.skill.body?.trim()) {
        return '`skill.body` is required and must not be empty.';
      }
    }
    return null;
  }

  protected createInvocation(
    params: LearnParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<LearnParams, ToolResult> {
    return new LearnInvocation(
      this.backend,
      this.managedSkillsDir,
      this.config.getTargetDir(),
      this.config.getSessionId(),
      params,
      messageBus,
      toolName ?? this.name,
      toolDisplayName ?? this.displayName,
    );
  }
}
