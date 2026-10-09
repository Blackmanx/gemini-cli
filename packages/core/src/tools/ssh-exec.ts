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
  type ToolCallConfirmationDetails,
  type ToolConfirmationOutcome,
  type ToolExecuteConfirmationDetails,
  type ToolResult,
} from './tools.js';
import {
  buildSudoCommand,
  isDestructiveCommand,
  requiresSudo,
  SshConnectionPool,
  type SshExecResult,
} from '../services/sshClient.js';
import type {
  SshProfile,
  SshProfileService,
} from '../services/sshProfileService.js';
import { debugLogger } from '../utils/debugLogger.js';
import { SSH_EXEC_DISPLAY_NAME, SSH_EXEC_TOOL_NAME } from './tool-names.js';

/** Longest command output kept for the model, mirroring the shell tool's cap. */
const MAX_OUTPUT_CHARS = 30_000;

/** Default ceiling when the model does not ask for a longer window. */
const DEFAULT_TIMEOUT_MS = 30_000;

const MAX_TIMEOUT_MS = 600_000;

export interface SshExecParams {
  /** The saved profile to run on, as named at `/ssh-add`. */
  profile: string;
  /** The shell command to run on the remote host. */
  command: string;
  /**
   * How long to wait. Defaults to 30s; commands like `apt` or a deploy need
   * more, and the tool call fails loudly rather than hanging the session.
   */
  timeout_ms?: number;
}

interface SshExecToolOptions {
  profiles: SshProfileService;
  /** The profile `/ssh` selected, used when the model does not name one. */
  getActiveProfile: () => SshProfile | null;
}

/**
 * Runs a shell command on a saved remote host.
 *
 * The command executes on the remote's own shell through an `exec` channel, so
 * its output, stderr and exit status are the remote's, not a rendering of a
 * local shell's. State does not persist between calls beyond the connection
 * itself: the next command starts clean.
 */
export class SshExecTool extends BaseDeclarativeTool<
  SshExecParams,
  ToolResult
> {
  static readonly Name = SSH_EXEC_TOOL_NAME;

  private readonly pool: SshConnectionPool;

  constructor(
    private readonly options: SshExecToolOptions,
    messageBus: MessageBus,
  ) {
    super(
      SshExecTool.Name,
      SSH_EXEC_DISPLAY_NAME,
      'Executes a shell command on a Linux server you have saved with /ssh-add, and returns its output, stderr and exit code. Use this for work on a remote host; the local shell tool does not reach it.',
      Kind.Execute,
      // JSON Schema literals, not @google/genai's `Type` enum: the parameter
      // validator compiles this with ajv, which rejects the enum's uppercase
      // forms and then silently skips validation altogether.
      {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            description:
              'Saved profile name from /ssh-add. Optional when a host is already active via /ssh.',
          },
          command: {
            type: 'string',
            description:
              'The shell command to run on the remote host, e.g. "systemctl status nginx" or "df -h".',
          },
          timeout_ms: {
            type: 'number',
            description: `Milliseconds to wait before giving up. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
          },
        },
        required: ['command'],
      },
      messageBus,
    );

    this.pool = new SshConnectionPool(options.profiles);
  }

  protected createInvocation(
    params: SshExecParams,
    messageBus: MessageBus,
  ): SshExecToolInvocation {
    return new SshExecToolInvocation(
      params,
      this.options,
      this.pool,
      messageBus,
      this.name,
      this.displayName,
    );
  }

  /**
   * Schema validation only checks types, so an empty or absurd timeout still
   * reaches the client. Clamping here keeps a model-authored `timeout_ms: 0`
   * from failing every remote command with a spurious timeout.
   */
  protected override validateToolParamValues(
    params: SshExecParams,
  ): string | null {
    if (!params.command || params.command.trim() === '') {
      return "The 'command' parameter must be a non-empty shell command.";
    }
    if (
      params.timeout_ms !== undefined &&
      (!Number.isFinite(params.timeout_ms) || params.timeout_ms <= 0)
    ) {
      return `The 'timeout_ms' parameter must be a positive number, got ${params.timeout_ms}.`;
    }
    return null;
  }
}

/**
 * One `ssh_exec` call.
 *
 * The two behaviours worth reading: destructive commands are confirmed through
 * the ordinary `exec` confirmation UI, so the operator sees the exact command
 * before it runs; and `sudo` is refused outright when the profile has no
 * stored sudo password, rather than attempting it and reporting a failure.
 */
export class SshExecToolInvocation extends BaseToolInvocation<
  SshExecParams,
  ToolResult
> {
  constructor(
    params: SshExecParams,
    private readonly options: SshExecToolOptions,
    private readonly pool: SshConnectionPool,
    messageBus: MessageBus,
    toolName: string,
    toolDisplayName: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    const target = this.resolveProfile();
    return target
      ? `Running on ${target.user}@${target.host}: ${this.params.command}`
      : this.params.command;
  }

  override getDisplayTitle(): string {
    const target = this.resolveProfile();
    return target
      ? `${target.user}@${target.host}: ${this.params.command}`
      : this.params.command;
  }

  override getExplanation(): string {
    const target = this.resolveProfile();
    if (!target) {
      return '';
    }
    return `Runs on ${target.user}@${target.host}:${target.port} over SSH, in a session you can watch.`;
  }

  /**
   * Resolves the profile this call targets, or null when the model named
   * neither a saved profile nor has one active.
   */
  private resolveProfile(): SshProfile | null {
    const named = this.params.profile?.trim();
    if (named) {
      return this.options.profiles.get(named);
    }
    return this.options.getActiveProfile();
  }

  protected override async getConfirmationDetails(
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    if (!isDestructiveCommand(this.params.command)) {
      return false;
    }

    const target = this.resolveProfile();
    if (!target) {
      return false;
    }

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: `Confirm destructive remote command on ${target.host}`,
      command: this.params.command,
      rootCommand: this.params.command,
      rootCommands: [this.params.command],
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        debugLogger.log(
          `ssh_exec destructive command outcome: ${outcome} on ${target.host}`,
        );
      },
    };
    void abortSignal;
    return confirmationDetails;
  }

  async execute(options: { abortSignal: AbortSignal }): Promise<ToolResult> {
    const target = this.resolveProfile();
    if (!target) {
      const known = this.options.profiles
        .list()
        .map((profile) => profile.name)
        .join(', ');
      throw new Error(
        this.params.profile
          ? `No SSH profile named "${this.params.profile}". Run /ssh to see saved profiles, or /ssh-add to create one. Saved: ${known || 'none'}.`
          : `No active SSH host. Run /ssh <profile> to connect first, or name a profile with the profile argument. Saved: ${known || 'none'}.`,
      );
    }

    const timeout = Math.min(
      Math.max(this.params.timeout_ms ?? DEFAULT_TIMEOUT_MS, 1_000),
      MAX_TIMEOUT_MS,
    );

    const sudoPassword = requiresSudo(this.params.command)
      ? await this.options.profiles.getSudoPassword(target.name)
      : null;
    if (requiresSudo(this.params.command) && !sudoPassword) {
      throw new Error(
        `Profile "${target.name}" has no sudo password, so sudo is not available on ${target.host}. Add one with /ssh-add ${target.name}, or run the command without sudo.`,
      );
    }

    const remoteCommand = sudoPassword
      ? buildSudoCommand(this.params.command, sudoPassword)
      : this.params.command;

    const connection = await this.pool.get(target);
    const result = await connection.exec(remoteCommand, {
      timeoutMs: timeout,
      signal: options.abortSignal,
    });

    const output = truncate(
      result.stdout || result.stderr || '(no output)',
      MAX_OUTPUT_CHARS,
    );
    const status = result.timedOut
      ? 'timed out'
      : `exit ${result.exitCode ?? 'none'}`;

    return {
      llmContent: this.toLlmContent(target, result),
      // The `display` block is what carries the tool's own identity into the
      // transcript, so a remote command is never mistaken for a local shell
      // command: it names the host it ran on and its own exit status.
      display: {
        name: this._toolDisplayName ?? SSH_EXEC_TOOL_NAME,
        description: `${target.user}@${target.host}: ${this.params.command}`,
        resultSummary: `${status} · ${result.durationMs}ms`,
        format: 'box',
        result: { type: 'text', text: output },
      },
      returnDisplay: output,
    };
  }

  private toLlmContent(
    target: SshProfile,
    result: SshExecResult,
  ): ToolResult['llmContent'] {
    // A non-zero exit is evidence about the remote, not a transport failure,
    // so it is reported as content rather than raised as an error.
    return [
      `exit code: ${result.exitCode ?? 'none'}`,
      `duration: ${result.durationMs}ms${result.timedOut ? ' (TIMED OUT)' : ''}`,
      `host: ${target.user}@${target.host}`,
      '',
      truncate(
        result.stdout || result.stderr || '(no output)',
        MAX_OUTPUT_CHARS,
      ),
    ].join('\n');
  }
}

/**
 * Clips output to a readable size, keeping the tail.
 *
 * The tail is where a command's conclusion lives: the last lines of a log, the
 * final error, the summary row of `df`.
 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `... (${text.length - limit} earlier characters omitted)\n${text.slice(-limit)}`;
}
