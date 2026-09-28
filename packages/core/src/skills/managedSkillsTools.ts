/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `manage_skill` tool: create, update, or delete a managed skill — a
 * `SKILL.md` the model writes for itself in a directory this CLI owns, so a
 * successful call is surfaced in the `<available_skills>` section of the system
 * prompt and is read back in later sessions.
 *
 * The filesystem hardening (name allowlist, prompt-injection-safe descriptions,
 * symlink/hard-link refusal) lives in `managedSkills.ts`. This file is only the
 * tool surface: it owns the parameter contract and turns every refusal into a
 * tool error the model can read and correct, never an exception.
 */
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { ToolErrorType } from '../tools/tool-error.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolLocation,
  type ToolResult,
} from '../tools/tools.js';
import {
  deleteManagedSkill,
  getManagedSkillPath,
  isValidManagedSkillName,
  sanitizeSkillName,
  writeManagedSkill,
  type ManagedSkill,
} from './managedSkills.js';
import { getErrorMessage } from '../utils/errors.js';

/** Internal tool name used in the model-facing call. */
export const MANAGE_SKILL_TOOL_NAME = 'manage_skill';

/** User-facing tool name shown in confirmations and the UI. */
const MANAGE_SKILL_DISPLAY_NAME = 'Manage Skill';

/**
 * Callback the host supplies to make a mutation visible: the caller owns skill
 * discovery, so it also owns the reload. Optional so the tool can be
 * constructed — and exercised — without a wired-up manager.
 */
export type RefreshSkillsCallback = () => void | Promise<void>;

/** Parameters accepted by {@link ManageSkillTool}. */
export interface ManageSkillParams {
  /** What to do with the managed skill. */
  action: 'create' | 'update' | 'delete';
  /** kebab-case skill name; also the directory name under the managed root. */
  name: string;
  /**
   * One-line description of when to use the skill. Required for `create` and
   * `update`; ignored for `delete`.
   */
  description?: string;
  /**
   * The markdown body of the `SKILL.md`, without frontmatter. Required for
   * `create` and `update`; ignored for `delete`.
   */
  body?: string;
}

/** Leading word used in the confirmation prompt for each action. */
const ACTION_VERBS: Record<ManageSkillParams['action'], string> = {
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
};

const TOOL_DESCRIPTION = `Create, update, or delete a managed skill.

A managed skill is a SKILL.md the assistant writes for itself in a dedicated
directory, so it can be recalled in later sessions. Use this only for durable,
reusable knowledge (a repeatable procedure, a project-specific command
sequence, a format the user asked for); do not store one-off facts, secrets, or
anything copied verbatim out of an untrusted file.

"create" and "update" require both "description" (one line: when to use this
skill) and "body" (the markdown instructions, no frontmatter). "delete" needs
only "name". Names are lowercase kebab-case, 1-64 characters. An existing skill
cannot be clobbered: use "update" to change one.`;

const PARAMETER_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'update', 'delete'],
      description: 'Whether to add, replace, or remove the managed skill.',
    },
    name: {
      type: 'string',
      description:
        'Skill name: lowercase letters, digits, and hyphens, starting with a letter or digit (1-64 chars).',
    },
    description: {
      type: 'string',
      description:
        'One-line description of when to use the skill (required for create/update).',
    },
    body: {
      type: 'string',
      description:
        'The SKILL.md body in markdown, without frontmatter (required for create/update).',
    },
  },
  required: ['action', 'name'],
  additionalProperties: false,
};

/** Builds the `ToolResult` that every refusal in this file returns. */
function toolError(message: string, type: ToolErrorType): ToolResult {
  return {
    llmContent: `Error: ${message}`,
    returnDisplay: message,
    error: { message, type },
  };
}

class ManageSkillInvocation extends BaseToolInvocation<
  ManageSkillParams,
  ToolResult
> {
  constructor(
    params: ManageSkillParams,
    private readonly config: Config,
    private readonly rootDir: string,
    private readonly refreshSkills: RefreshSkillsCallback | undefined,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    return `${ACTION_VERBS[this.params.action]} managed skill "${this.params.name}"`;
  }

  override toolLocations(): ToolLocation[] {
    // The name has already been through `validateToolParamValues`, so this
    // cannot resolve outside the managed root.
    return [{ path: getManagedSkillPath(this.rootDir, this.params.name) }];
  }

  async execute(): Promise<ToolResult> {
    const { action, name, description, body } = this.params;
    try {
      if (action === 'delete') {
        if (!deleteManagedSkill(this.rootDir, name)) {
          return toolError(
            `Managed skill "${name}" does not exist. Nothing to delete.`,
            ToolErrorType.INVALID_TOOL_PARAMS,
          );
        }
        await this.refreshSkills?.();
        return {
          llmContent: `Deleted managed skill "${name}".`,
          returnDisplay: `Deleted managed skill \`${name}\`.`,
        };
      }

      // `validateToolParamValues` already required both fields for
      // create/update; this narrows the optional parameters to the strings the
      // store's contract takes, without asserting anything about them.
      if (typeof description !== 'string' || typeof body !== 'string') {
        return toolError(
          `Action "${action}" requires both "description" and "body".`,
          ToolErrorType.INVALID_TOOL_PARAMS,
        );
      }

      // Discovery is keyed by skill name, so a create that lands on a name
      // another location already claims would either never surface (shadowed by
      // that skill) or silently displace it. Refuse up front rather than
      // report a success that changes nothing. The managed directory itself is
      // exempt — if the file is already there, `create` fails with EEXIST
      // anyway.
      if (action === 'create' && this.isNameClaimedElsewhere(name)) {
        return toolError(
          `Cannot create managed skill "${name}": another location already provides a skill of that name, and managed skills cannot replace one. Choose a different name, or use action "update".`,
          ToolErrorType.INVALID_TOOL_PARAMS,
        );
      }

      const skill: ManagedSkill = { name, description, body };
      writeManagedSkill(this.rootDir, skill, action);
      await this.refreshSkills?.();

      // `relative` already ends in `SKILL.md`; showing it as the location
      // tells the model exactly which file it just wrote.
      const relative = path.relative(
        this.rootDir,
        getManagedSkillPath(this.rootDir, name),
      );
      const verb = action === 'create' ? 'Created' : 'Updated';
      const text = `${verb} managed skill "${name}" (${relative}).`;
      return { llmContent: text, returnDisplay: text };
    } catch (error) {
      // The store refuses with a precise, actionable message (bad name,
      // symlinked or non-regular file, hard link, missing/existing file,
      // oversized or empty content). Surface it verbatim so the model can fix
      // the call rather than see an opaque failure.
      return toolError(getErrorMessage(error), ToolErrorType.EXECUTION_FAILED);
    }
  }

  /**
   * Whether the skill manager currently knows `name` from a location other than
   * the managed directory this tool writes to.
   */
  private isNameClaimedElsewhere(name: string): boolean {
    if (!isValidManagedSkillName(name)) {
      return false;
    }
    const existing = this.config.getSkillManager().getSkill(name);
    if (!existing) {
      return false;
    }
    const managedPath = path.resolve(getManagedSkillPath(this.rootDir, name));
    return path.resolve(existing.location) !== managedPath;
  }
}

/**
 * Declarative tool for direct create/update/delete of managed skills.
 *
 * The managed root is passed in rather than resolved here: the host owns where
 * managed skills live (and may sandbox or relocate them), so this tool must not
 * decide that. Pass `refreshSkills` so a successful mutation is followed by the
 * host's own skill reload.
 */
export class ManageSkillTool extends BaseDeclarativeTool<
  ManageSkillParams,
  ToolResult
> {
  static readonly Name = MANAGE_SKILL_TOOL_NAME;

  constructor(
    private readonly config: Config,
    private readonly rootDir: string,
    messageBus: MessageBus,
    private readonly refreshSkills?: RefreshSkillsCallback,
  ) {
    super(
      ManageSkillTool.Name,
      MANAGE_SKILL_DISPLAY_NAME,
      TOOL_DESCRIPTION,
      Kind.Other,
      PARAMETER_SCHEMA,
      messageBus,
    );
  }

  /**
   * Enforces the cross-field contract, which a flat JSON Schema cannot express:
   * `delete` needs nothing but a name, while `create` and `update` are
   * meaningless without both `description` and `body`.
   *
   * The name is validated here rather than left to the store so an unusable name
   * comes back as a parameter error with the reason, without touching the file
   * system. Size and emptiness limits stay in the store, which is where the
   * exact serialized size is known.
   */
  protected override validateToolParamValues(
    params: ManageSkillParams,
  ): string | null {
    if (params.action === 'delete') {
      return null;
    }

    const missing: string[] = [];
    if (
      typeof params.description !== 'string' ||
      params.description.trim() === ''
    ) {
      missing.push('"description"');
    }
    if (typeof params.body !== 'string' || params.body.trim() === '') {
      missing.push('"body"');
    }
    if (missing.length > 0) {
      return `Action "${params.action}" requires both "description" and "body"; missing ${missing.join(
        ' and ',
      )}. "delete" requires only "name".`;
    }

    try {
      sanitizeSkillName(params.name);
    } catch (error) {
      return getErrorMessage(error);
    }
    return null;
  }

  protected createInvocation(
    params: ManageSkillParams,
    messageBus: MessageBus,
    toolName: string,
    toolDisplayName: string,
  ): ToolInvocation<ManageSkillParams, ToolResult> {
    return new ManageSkillInvocation(
      params,
      this.config,
      this.rootDir,
      this.refreshSkills,
      messageBus,
      toolName,
      toolDisplayName,
    );
  }
}
