/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thin, non-interactive wrapper around the GitHub CLI (`gh`).
 *
 * Every invocation is non-interactive by construction: prompts are disabled,
 * git never asks for credentials on a terminal, colour is suppressed, and
 * stdin is closed. Credentials are only ever read from `gh`'s own store
 * (`~/.config/gh`) or from an inherited `GH_TOKEN` in the environment — a
 * token is never accepted as, or passed through, a command-line argument,
 * where it would be visible in process listings and shell history.
 *
 * Output is capped per stream so a runaway `gh` cannot exhaust the model
 * context; truncation is always marked.
 */

import { spawn } from 'node:child_process';
import { resolveExecutable } from '../utils/shell-utils.js';
import { getErrorMessage } from '../utils/errors.js';

/** The GitHub CLI binary this service shells out to. */
export const GH_EXECUTABLE = 'gh';

/** Default wall-clock budget for a single `gh` invocation. */
export const GH_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Cap on captured stdout. Generous enough for the largest structured payload
 * the tool renders (`gh api` on a repository tree is the big one) while still
 * bounding what a misbehaving or hostile response can cost.
 */
export const GH_STDOUT_LIMIT_BYTES = 1024 * 1024;

/** stderr is only ever read for failure messages, so it gets a tighter cap. */
export const GH_STDERR_LIMIT_BYTES = 64 * 1024;

/**
 * Reported whenever `gh` is missing, unauthenticated, or unusable. The tool
 * surfaces this verbatim so the failure names the real cause instead of
 * surfacing an opaque non-zero exit.
 */
export const GH_UNAVAILABLE_MESSAGE =
  'The `gh` CLI is not installed or not authenticated. Install it from https://cli.github.com/ and run `gh auth login`.';

/** Result of a completed `gh` invocation. Never thrown on a non-zero exit. */
export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Per-call knobs. `signal` cancels; `timeoutMs` bounds the wall clock. */
export interface GhRunOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Why a `gh` invocation failed, for callers that branch on the cause. */
export type GhErrorKind =
  | 'unavailable'
  | 'timeout'
  | 'aborted'
  | 'command_failed'
  | 'invalid_json';

/** Typed failure raised by {@link GhService.json} and by spawn-level problems. */
export class GhError extends Error {
  constructor(
    readonly kind: GhErrorKind,
    message: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'GhError';
  }
}

/**
 * Any value `JSON.parse` can produce. `GhService.json` is bounded by it so a
 * caller cannot ask for a shape the transport cannot carry.
 */
export type GhJsonValue =
  | string
  | number
  | boolean
  | null
  | GhJsonValue[]
  | { [key: string]: GhJsonValue };

const AUTH_FAILURE_PATTERN =
  /gh auth login|not logged into any GitHub hosts|HTTP 401: Bad credentials/i;

const REPO_CONTEXT_PATTERN =
  /not a git repository|no git remotes found|unable to determine current repository/i;

function isGhJsonValue(value: unknown): value is GhJsonValue {
  if (value === null) {
    return true;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isGhJsonValue);
  }
  if (typeof value !== 'object') {
    return false;
  }
  return Object.values(value).every(isGhJsonValue);
}

/**
 * Narrows a parsed payload to the caller's declared shape. The transport can
 * only vouch for "this is JSON"; field-level shape is the caller's contract.
 */
function isGhJsonPayload<T extends GhJsonValue>(value: unknown): value is T {
  return isGhJsonValue(value);
}

/**
 * Environment for every `gh` child. `GH_PROMPT_DISABLED` stops `gh` opening
 * an interactive prompt, `GIT_TERMINAL_PROMPT=0` stops the git calls it makes
 * on our behalf from blocking on credential input, and `NO_COLOR`/`CLICOLOR=0`
 * keep ANSI escapes out of the captured text.
 */
function buildGhEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'true',
    GIT_EDITOR: 'true',
    NO_COLOR: '1',
    CLICOLOR: '0',
    GH_PAGER: 'cat',
    PAGER: 'cat',
  };
}

/**
 * Accumulates one output stream up to a byte budget, keeping the head and
 * discarding the rest. `total` tracks what the process actually produced so
 * the truncation marker can say how much was dropped.
 */
class CappedCapture {
  private readonly chunks: Buffer[] = [];
  private captured = 0;
  private total = 0;

  constructor(private readonly limitBytes: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.byteLength;
    if (this.captured >= this.limitBytes) {
      return;
    }
    const take = Math.min(chunk.byteLength, this.limitBytes - this.captured);
    if (take <= 0) {
      return;
    }
    this.chunks.push(chunk.subarray(0, take));
    this.captured += take;
  }

  toText(): string {
    const text = Buffer.concat(this.chunks).toString('utf8');
    if (this.total <= this.captured) {
      return text;
    }
    const dropped = this.total - this.captured;
    return `${text}\n[gh output truncated: ${this.captured} of ${this.total} bytes kept, ${dropped} dropped]\n`;
  }
}

/**
 * Turn a non-zero `gh` exit into a message that names the actual cause. Raw
 * `gh` failures are terse ("HTTP 404") or misleading (a repo-context error
 * when the caller passed `repo` explicitly), so both are rewritten.
 */
export function describeGhFailure(
  args: readonly string[],
  result: GhResult,
): string {
  const invocation = `gh ${args.join(' ')}`;
  const message = (result.stderr || result.stdout).trim();

  if (AUTH_FAILURE_PATTERN.test(message)) {
    return 'GitHub CLI is not authenticated. Run `gh auth login`.';
  }
  if (REPO_CONTEXT_PATTERN.test(message)) {
    return `GitHub repository context is unavailable. Pass \`repo\` explicitly or run inside a GitHub checkout. (${invocation})`;
  }
  if (message) {
    return `${message} (exit ${result.exitCode}: ${invocation})`;
  }
  return `GitHub CLI command failed with exit code ${result.exitCode}: ${invocation}`;
}

/**
 * The sanctioned `gh` runner: non-interactive environment, bounded capture,
 * and a wall-clock deadline. `run` deliberately resolves on a non-zero exit
 * so callers can render the captured stderr themselves.
 */
export class GhService {
  constructor(private readonly opts: { signal?: AbortSignal } = {}) {}

  /**
   * Whether `gh` is installed *and* authenticated. Resolves `false` — never
   * throws — for a missing binary, a failing `gh --version`, or a host the
   * user has not logged into.
   */
  async isAvailable(cwd: string): Promise<boolean> {
    if (resolveExecutable(GH_EXECUTABLE) === undefined) {
      return false;
    }
    const result = await this.spawnSafely(['--version'], {
      cwd,
      timeoutMs: 15_000,
    });
    if (result === undefined) {
      return false;
    }
    if (result.exitCode !== 0) {
      return false;
    }
    const auth = await this.spawnSafely(['auth', 'status'], {
      cwd,
      timeoutMs: 20_000,
    });
    return auth !== undefined && auth.exitCode === 0;
  }

  /** Run `gh` and capture bounded stdout/stderr plus the exit code. */
  async run(args: readonly string[], options: GhRunOptions): Promise<GhResult> {
    const result = await this.spawn(args, options);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }

  /**
   * Run `gh` and parse stdout as JSON. A non-zero exit, empty output, or
   * non-JSON output all raise a {@link GhError} naming the cause.
   */
  async json<T extends GhJsonValue>(
    args: readonly string[],
    options: GhRunOptions,
  ): Promise<T> {
    const result = await this.run(args, options);
    const invocation = `gh ${args.join(' ')}`;
    if (result.exitCode !== 0) {
      throw new GhError(
        'command_failed',
        describeGhFailure(args, result),
        result.exitCode,
      );
    }
    if (!result.stdout) {
      throw new GhError(
        'invalid_json',
        `${invocation} returned no output.`,
        result.exitCode,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new GhError(
        'invalid_json',
        `${invocation} returned invalid JSON: ${getErrorMessage(error)}`,
        result.exitCode,
      );
    }
    if (!isGhJsonPayload<T>(parsed)) {
      throw new GhError(
        'invalid_json',
        `${invocation} returned JSON that is not a plain value.`,
        result.exitCode,
      );
    }
    return parsed;
  }

  /**
   * Availability probe that never throws. Used by {@link isAvailable} so a
   * broken environment degrades to `false` rather than an exception.
   */
  private async spawnSafely(
    args: readonly string[],
    options: GhRunOptions,
  ): Promise<GhResult | undefined> {
    try {
      return await this.run(args, options);
    } catch {
      return undefined;
    }
  }

  private spawn(
    args: readonly string[],
    options: GhRunOptions,
  ): Promise<GhResult> {
    const executable = resolveExecutable(GH_EXECUTABLE);
    if (executable === undefined) {
      return Promise.reject(new GhError('unavailable', GH_UNAVAILABLE_MESSAGE));
    }

    const timeoutMs = options.timeoutMs ?? GH_DEFAULT_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signals: AbortSignal[] = [timeoutSignal];
    if (this.opts.signal) {
      signals.push(this.opts.signal);
    }
    if (options.signal) {
      signals.push(options.signal);
    }
    const signal = AbortSignal.any(signals);

    const stdout = new CappedCapture(GH_STDOUT_LIMIT_BYTES);
    const stderr = new CappedCapture(GH_STDERR_LIMIT_BYTES);

    return new Promise<GhResult>((resolve, reject) => {
      const child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: buildGhEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        signal,
      });

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      child.on('error', (error: Error) => {
        if (timeoutSignal.aborted) {
          reject(
            new GhError(
              'timeout',
              `gh ${args.join(' ')} timed out after ${timeoutMs}ms.`,
            ),
          );
          return;
        }
        if (signal.aborted) {
          reject(new GhError('aborted', `gh ${args.join(' ')} was cancelled.`));
          return;
        }
        reject(
          new GhError(
            'unavailable',
            `${GH_UNAVAILABLE_MESSAGE} (${getErrorMessage(error)})`,
          ),
        );
      });

      child.on('close', (code: number | null) => {
        resolve({
          exitCode: code ?? 0,
          stdout: stdout.toText(),
          stderr: stderr.toText(),
        });
      });
    });
  }
}
