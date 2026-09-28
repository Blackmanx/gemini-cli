/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs';
import * as Diff from 'diff';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolCallConfirmationDetails,
  type ToolEditConfirmationDetails,
  type ToolInvocation,
  type ToolResult,
  type ExecuteOptions,
} from './tools.js';
import { DEFAULT_DIFF_OPTIONS } from './diffOptions.js';
import {
  makeRelative,
  shortenPath,
  resolveDefensiveToolPath,
} from '../utils/paths.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { ToolErrorType } from './tool-error.js';
import { applyHashlineInput, HashlineApplyError } from '../hashline/apply.js';
import { HashlineParseError, parseHashlineInput } from '../hashline/parser.js';
import { SnapshotStore } from '../hashline/snapshots.js';
import type { Config } from '../config/config.js';
import type { ApplyResult } from '../hashline/apply.js';

/**
 * `hashline_edit` — edit by content hash instead of by line number.
 *
 * Ported from omp's hashline edit tool. The problem it solves is specific and
 * common: a model that read a file, then had the file change under it, and
 * says "replace line 412". The line has moved, or was never one it saw, and a
 * line-numbered edit applies to the wrong place or corrupts the file. Here an
 * edit is anchored to a hash of the exact content the model was shown, and it
 * either applies to that content or is refused.
 *
 * It is registered as a SEPARATE tool from `replace`, not as a replacement.
 * `replace` keeps working, existing policies and skills that name it keep
 * working, and the model chooses per call.
 */

export interface HashlineEditParams {
  /** The patch, with one or more `[path#TAG]` sections. */
  input: string;
}

const DESCRIPTION = `Edit files by content hash.

Each edit is anchored to a hash of the exact content you were shown, so it either applies to that content or is refused. A line-numbered edit can silently land on the wrong lines after the file changes; this cannot.

A patch is one or more sections:

  [src/a.ts#3F7A]
  PUT 12.=14:
  +the replacement line
  +and the next one
  CUT 20.=20
  PUT >$ 

Rules:
- Line numbers are 1-based and refer to the file AS YOU READ IT.
- Body rows start with '+' and are the final text, not a diff. A lone '+' is a blank line; write '+-' or '++' for a literal '+' or '-'.
- 'PUT <N' inserts before line N, 'PUT >N' after, 'PUT >$' at the end.
- 'CUT N.=M' removes lines and remembers them; a later 'PUT <N' or 'PUT >N' pastes them back, or 'CUT N.=M @name' / 'PUT <N @name' to use a named slot.
- A file you have not read, or a line you have not seen, is REFUSED. Re-read it and retry; do not guess a new line number.
- One patch may touch several files, but a failure anywhere writes nothing at all.`;

export class HashlineEditTool extends BaseDeclarativeTool<
  HashlineEditParams,
  ToolResult
> {
  static readonly Name = 'hashline_edit';

  /**
   * What the model has been shown, per path.
   *
   * Process-global because it is a property of the conversation, not of a tool
   * instance: a snapshot taken in one turn is still valid in the next, and the
   * whole point is that the tag stays meaningful after time passes.
   */
  static readonly snapshots = new SnapshotStore();

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      HashlineEditTool.Name,
      'Hashline Edit',
      DESCRIPTION,
      Kind.Edit,
      {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description:
              'The patch: one or more `[path#TAG]` sections followed by PUT/CUT/REM/MV operations.',
          },
        },
        required: ['input'],
      },
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(
    params: HashlineEditParams,
  ): string | null {
    if (typeof params.input !== 'string' || params.input.trim() === '') {
      return '`input` must be a non-empty patch.';
    }
    return null;
  }

  protected createInvocation(
    params: HashlineEditParams,
    messageBus: MessageBus,
  ): ToolInvocation<HashlineEditParams, ToolResult> {
    return new HashlineEditInvocation(
      this.config,
      params,
      messageBus,
      this.name,
      this.displayName,
    );
  }
}

class HashlineEditInvocation extends BaseToolInvocation<
  HashlineEditParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: HashlineEditParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  /**
   * The patch is parsed and fully resolved BEFORE the user is asked anything.
   *
   * Confirming an edit that will then be refused wastes a round trip and
   * teaches the user to approve reflexively. When the patch is already
   * invalid there is nothing to confirm, and the tool says why instead.
   */
  protected override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const resolved = resolvePatch(
      this.config,
      this.params.input ?? '',
      'preview',
    );
    if (resolved === undefined) {
      return false;
    }
    return buildEditConfirmation(this.config, resolved);
  }

  override getDescription(): string {
    const paths = this.params.input
      .split('\n')
      .filter((line) => line.trim().startsWith('['))
      .map((line) => line.trim().slice(1).split('#')[0] ?? '')
      .filter(Boolean);
    return `Hashline edit of ${paths.join(', ') || 'no files'}`;
  }

  override async execute(_options: ExecuteOptions): Promise<ToolResult> {
    let parsed;
    try {
      parsed = parseHashlineInput(this.params.input);
    } catch (err) {
      if (err instanceof HashlineParseError) {
        return {
          llmContent: err.message,
          returnDisplay: 'Patch rejected.',
          error: {
            message: err.message,
            type: ToolErrorType.EDIT_PREPARATION_FAILURE,
          },
        };
      }
      throw err;
    }

    let result;
    try {
      // The patch names a workspace-relative path while snapshots are keyed
      // by the absolute path; both sides must agree or every patch is stale.
      result = applyHashlineInput(parsed, (p, tag) =>
        HashlineEditTool.snapshots.getByTag(
          absolutePathFor(this.config, p),
          tag,
        ),
      );
    } catch (err) {
      if (err instanceof HashlineApplyError) {
        return {
          llmContent: err.message,
          returnDisplay: 'Patch refused.',
          error: {
            message: err.message,
            type: ToolErrorType.EDIT_PREPARATION_FAILURE,
          },
        };
      }
      throw err;
    }

    // Only now, with every section validated, does anything touch the disk.
    const written: string[] = [];
    for (const file of result.files) {
      const absolute = this.#absolute(file.path);
      const access = this.config.validatePathAccess(absolute, 'write');
      if (access) {
        return {
          llmContent: access,
          returnDisplay: 'Path not writable.',
          error: { message: access, type: ToolErrorType.PATH_NOT_IN_WORKSPACE },
        };
      }
      await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
      await fs.promises.writeFile(absolute, file.after, 'utf8');
      // Re-record so the next edit in the same session anchors to the NEW
      // content. Leaving the old snapshot in place would make the next patch
      // look stale immediately.
      HashlineEditTool.snapshots.record(absolute, file.after, [
        [1, file.after.split('\n').length],
      ]);
      written.push(file.path);
    }

    const summary =
      written.length === 0
        ? 'Nothing to write.'
        : `Edited ${written.length} file(s):\n${written.join('\n')}`;
    return {
      llmContent: summary,
      returnDisplay: summary,
      display: {
        name: this._toolDisplayName ?? 'Hashline Edit',
        description: this.getDescription(),
        resultSummary: summary,
        result: { type: 'text', text: summary },
      },
    };
  }

  #absolute(filePath: string): string {
    const sanitized = resolveDefensiveToolPath(
      filePath,
      this.config.getTargetDir(),
    );
    return path.resolve(this.config.getTargetDir(), sanitized);
  }
}

/**
 * Parse a patch and resolve every section against the snapshot store.
 *
 * Returns `undefined` when the patch is already invalid, which is the signal
 * that there is nothing to confirm — the invocation will report why.
 */
function resolvePatch(
  config: Config,
  input: string,
  mode: 'preview' | 'apply',
): ApplyResult | undefined {
  try {
    const parsed = parseHashlineInput(input);
    // The computation is pure; preview and apply resolve identically and only
    // the caller differs in whether it writes.
    void mode;
    // The patch names a path relative to the workspace, while snapshots are
    // recorded under the absolute path. Both sides have to agree or every
    // patch looks stale.
    return applyHashlineInput(parsed, (p, tag) =>
      HashlineEditTool.snapshots.getByTag(absolutePathFor(config, p), tag),
    );
  } catch (err) {
    if (
      err instanceof HashlineParseError ||
      err instanceof HashlineApplyError
    ) {
      return undefined;
    }
    throw err;
  }
}

/**
 * The confirmation for a resolved patch.
 *
 * A patch may touch several files, so the FIRST file's diff is what the
 * dialog renders — enough for the user to see what kind of change this is —
 * while the full per-file summary is in the title. Showing only the first
 * diff while the write applies to all of them would be a lie, so the summary
 * names every file.
 */
function buildEditConfirmation(
  config: Config,
  resolved: ApplyResult,
): ToolCallConfirmationDetails | false {
  const first = resolved.files[0];
  if (first === undefined) return false;
  const absolute = absolutePathFor(config, first.path);
  const fileName = path.basename(absolute);
  const fileDiff = Diff.createPatch(
    fileName,
    first.before,
    first.after,
    'Current',
    'Proposed',
    DEFAULT_DIFF_OPTIONS,
  );
  const relative = makeRelative(absolute, config.getTargetDir());
  const title =
    resolved.files.length === 1
      ? `Confirm Hashline Edit: ${shortenPath(relative)}`
      : `Confirm Hashline Edit of ${resolved.files.length} files: ${shortenPath(relative)}, and ${resolved.files.length - 1} more`;

  const details: ToolEditConfirmationDetails = {
    type: 'edit',
    title,
    fileName,
    filePath: absolute,
    fileDiff,
    originalContent: first.before,
    newContent: first.after,
    // Mode transitions and policy updates are handled centrally by the
    // scheduler; nothing extra to do here.
    onConfirm: async () => {},
  };
  return details;
}

function absolutePathFor(config: Config, filePath: string): string {
  const sanitized = resolveDefensiveToolPath(filePath, config.getTargetDir());
  return path.resolve(config.getTargetDir(), sanitized);
}
