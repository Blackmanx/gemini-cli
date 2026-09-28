/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { InjectionSource } from '../config/injectionService.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ExecuteOptions,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';

/** Hard ceiling on a single wait, mirroring omp's 30 minute cap. */
const WAIT_MAX_MS = 30 * 60_000;

/**
 * Window ladder (ms) for a wait that only a message can end: no background job
 * is running, so there is no job-wait to park on and a message is all that
 * remains. Consecutive waits climb the rungs so a tight wait loop backs off
 * instead of hammering the (unimplemented) peer bus every few seconds.
 */
const MESSAGE_WAIT_LADDER_MS = [
  5_000, 10_000, 30_000, 60_000, 300_000,
] as const;

/**
 * A gap this long since the last message-only wait means the agent did real
 * work in between, so the next one restarts at the floor of the ladder.
 */
const MESSAGE_WAIT_LADDER_RESET_MS = 60_000;

/**
 * Rung and end time of the last message-only wait. This is module state, not
 * per-instance state, on purpose: the ladder backs off a *process-wide* wait
 * loop, and every agent in the process shares the same barrier, so a per
 * instance rung would let N instances all sit on the floor at once. It is
 * advisory only — nothing is ever gated on it, so concurrent waits cannot
 * deadlock each other over it.
 */
let lastMessageWait: { level: number; endedAt: number } | undefined;

interface MessageWindow {
  level: number;
  openedAt: number;
  deadline: number;
}

/**
 * Broadcast-only seam for peer messages. Deliberately has no "take"/"drain": a
 * message fans out to every subscriber, so two waits issued in the same
 * parallel tool batch both observe it and neither can starve the other.
 */
export interface WaitPeerMessageSource {
  subscribe(listener: (message: string) => void): () => void;
  /**
   * Whether anyone could actually message the caller right now.
   *
   * A bus being installed is not enough. Without this, every session would
   * open a message window on every wait and block on a peer that does not
   * exist — turning a fast "nothing to wait for" into a multi-second stall.
   * Optional, so a source that cannot answer is treated as capable, which is
   * the conservative direction.
   */
  hasLivePeers?(): boolean;
}

let peerMessageSource: WaitPeerMessageSource | undefined;

/**
 * Installs the peer message source used by every {@link WaitTool} in this
 * process. Pass `undefined` to close the seam again.
 */
export function setWaitPeerMessageSource(
  source: WaitPeerMessageSource | undefined,
): void {
  peerMessageSource = source;
}

/**
 * What ended a blocking wait. Resolved exactly once, by the first wake source
 * to fire, after which every other source is torn down.
 */
type WaitWake =
  | { kind: 'injection'; source: InjectionSource; text: string }
  | { kind: 'job'; pid: number; command: string; exitCode: number }
  | { kind: 'message-window'; elapsedMs: number }
  | { kind: 'cap' }
  | { kind: 'abort' };

/**
 * The model-facing contract of `wait` is empty: it takes no arguments, exactly
 * as in omp. Exported as an alias rather than an `interface X {}` because the
 * repo's lint config rejects empty interfaces; `Record<string, never>` is the
 * repo's existing spelling of a zero-parameter tool (see
 * `ListBackgroundProcessesTool`).
 */
export type WaitToolParams = Record<string, never>;

function interruptedResult(reason: string): ToolResult {
  const text = `Wait interrupted: ${reason}. Nothing was consumed and nothing is lost; re-plan or continue with other work.`;
  return { llmContent: text, returnDisplay: text };
}

function nothingToWaitForResult(): ToolResult {
  return {
    llmContent:
      'Nothing to wait for: no background shell process is running, no background completion is in flight, and no peer-message source is installed. ' +
      'Do not call `wait` again until you have started something to wait on.',
    returnDisplay: 'Nothing to wait for.',
  };
}

class WaitToolInvocation extends BaseToolInvocation<
  WaitToolParams,
  ToolResult
> {
  constructor(
    private readonly context: AgentLoopContext,
    params: WaitToolParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  getDescription(): string {
    return 'Wait for the next background result or peer message';
  }

  async execute({
    abortSignal,
    updateOutput,
  }: ExecuteOptions): Promise<ToolResult> {
    const injectionService = this.context.config.injectionService;
    const hardDeadline = Date.now() + WAIT_MAX_MS;
    // Opened by the first message-only block and kept across re-evaluations,
    // so a peer that stops mid-window cannot restart the window and grant
    // itself a fresh full rung.
    let messageWindow: MessageWindow | undefined;

    try {
      for (;;) {
        if (abortSignal.aborted) {
          return interruptedResult('aborted before the wait began');
        }

        // Injections are never cleared by the injection service itself, so an
        // unscoped "is anything pending?" probe would latch onto the first
        // background job of the session and report a result forever after.
        // Scope the probe to injections that arrived after this wait started;
        // older ones belong to the transcript already being assembled.
        const startIndex = injectionService.getLatestInjectionIndex();

        // Wake source 3: a background shell process. Wired: ShellExecutionService
        // records every backgrounded execution against the session and reports
        // its exit through ExecutionLifecycleService.
        const running = this.listRunningBackgroundProcesses();

        // Wake source 1: a peer message. Only a reason to keep waiting when
        // someone could actually send one — a bus with no live peers must not
        // turn a fast answer into a multi-second stall.
        const messageCapable =
          peerMessageSource !== undefined &&
          (peerMessageSource.hasLivePeers?.() ?? true);

        // Wake source 4: an in-flight subagent. NOT reachable from here: the
        // repo has no registry of running agent invocations. A scheduler turn
        // awaits its tool calls with `Promise.all`, so an `invoke_agent` in the
        // same parallel batch as this wait *is* running concurrently, but
        // nothing exposes that fact to a tool. It is therefore never counted as
        // a reason to keep waiting, rather than being faked. The seam to close
        // is a "count in-flight agent invocations" accessor alongside
        // `ShellExecutionService.listBackgroundProcesses`; when it exists it
        // belongs in the guard below.
        if (running.length === 0 && !messageCapable) {
          return nothingToWaitForResult();
        }

        const window =
          running.length === 0
            ? (messageWindow ??= this.openMessageWindow())
            : undefined;

        const wake = await this.blockUntilWake({
          running,
          messageWindow: window,
          hardDeadline,
          startIndex,
          abortSignal,
          updateOutput,
        });

        switch (wake.kind) {
          case 'abort':
            return interruptedResult('the turn was interrupted while waiting');
          case 'injection':
            return {
              llmContent:
                wake.source === 'background_completion'
                  ? `A background execution finished while you were waiting:\n\n${wake.text}`
                  : `The user steered in while you were waiting:\n\n${wake.text}`,
              returnDisplay: `Woken by a ${wake.source} injection.`,
            };
          case 'job': {
            const text = `Background process ${wake.pid} (\`${wake.command}\`) finished with exit code ${wake.exitCode}. Read its output with \`read_background_output\` before drawing conclusions.`;
            return { llmContent: text, returnDisplay: text };
          }
          case 'message-window':
            return {
              llmContent: `No message arrived during a ${Math.round(wake.elapsedMs / 1000)}s message-only window, and no background work was running. Either start work worth waiting on, or answer without waiting.`,
              returnDisplay: `No message after ${Math.round(wake.elapsedMs / 1000)}s.`,
            };
          case 'cap':
            return {
              llmContent: `Waited the maximum ${WAIT_MAX_MS / 60_000} minutes without a wake event. Background work may still be running; check \`list_background_processes\` rather than waiting again.`,
              returnDisplay: 'Wait limit reached.',
            };
          default: {
            // `WaitWake` is closed, so this arm is unreachable. Expressed as a
            // `never` binding so adding a variant without a result arm becomes
            // a compile error rather than a silent fall-through.
            const unhandled: never = wake;
            throw new Error(
              `Unhandled wait wake kind: ${JSON.stringify(unhandled)}`,
            );
          }
        }
      }
    } finally {
      if (messageWindow) {
        lastMessageWait = { level: messageWindow.level, endedAt: Date.now() };
      }
    }
  }

  private listRunningBackgroundProcesses(): Array<{
    pid: number;
    command: string;
  }> {
    const sessionId = this.context.config.getSessionId();
    if (!sessionId) {
      return [];
    }
    return ShellExecutionService.listBackgroundProcesses(sessionId)
      .filter((process) => process.status === 'running')
      .map((process) => ({ pid: process.pid, command: process.command }));
  }

  private openMessageWindow(): MessageWindow {
    const now = Date.now();
    const last = lastMessageWait;
    const level =
      !last || now - last.endedAt >= MESSAGE_WAIT_LADDER_RESET_MS
        ? 0
        : Math.min(last.level + 1, MESSAGE_WAIT_LADDER_MS.length - 1);
    return {
      level,
      openedAt: now,
      deadline: now + MESSAGE_WAIT_LADDER_MS[level],
    };
  }

  /**
   * Block on one snapshot of the wake sources and resolve on the first one to
   * fire. Every listener, timer and abort handler registered here is scoped to
   * this call and removed in `finally`, so a wait never leaves state behind for
   * the next one and never holds anything another wait needs.
   */
  private async blockUntilWake(args: {
    running: Array<{ pid: number; command: string }>;
    messageWindow: MessageWindow | undefined;
    hardDeadline: number;
    startIndex: number;
    abortSignal: AbortSignal;
    updateOutput: ExecuteOptions['updateOutput'];
  }): Promise<WaitWake> {
    const { running, messageWindow, hardDeadline, abortSignal, updateOutput } =
      args;
    const injectionService = this.context.config.injectionService;

    const windowDeadline = messageWindow?.deadline ?? Number.POSITIVE_INFINITY;
    const capped = hardDeadline <= windowDeadline;

    const unsubscribes: Array<() => void> = [];
    let settled = false;
    let resolveWake: (wake: WaitWake) => void = () => {};
    const wakePromise = new Promise<WaitWake>((resolve) => {
      resolveWake = resolve;
    });
    const settle = (wake: WaitWake): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolveWake(wake);
    };

    // Wake source 1: peer message. Broadcast, so concurrent waits in one
    // parallel batch all see it.
    const source = peerMessageSource;
    if (source) {
      unsubscribes.push(
        source.subscribe((message) =>
          settle({ kind: 'injection', source: 'user_steering', text: message }),
        ),
      );
    }

    // Wake source 2: a new injection. A `user_steering` injection is a message
    // from the user and ends the wait just like a peer message; a
    // `background_completion` injection is a finished background job.
    const onInjection = (text: string, injectionSource: InjectionSource) => {
      if (injectionService.getInjectionsAfter(args.startIndex).includes(text)) {
        settle({ kind: 'injection', source: injectionSource, text });
      }
    };
    injectionService.onInjection(onInjection);
    unsubscribes.push(() => injectionService.offInjection(onInjection));

    // Wake source 3: exit of a background shell process.
    for (const process of running) {
      unsubscribes.push(
        ShellExecutionService.onExit(process.pid, (exitCode) =>
          settle({
            kind: 'job',
            pid: process.pid,
            command: process.command,
            exitCode,
          }),
        ),
      );
    }

    const timer = setTimeout(
      () =>
        settle(
          capped
            ? { kind: 'cap' }
            : {
                kind: 'message-window',
                elapsedMs: Date.now() - (messageWindow?.openedAt ?? Date.now()),
              },
        ),
      Math.max(0, Math.min(windowDeadline, hardDeadline) - Date.now()),
    );

    const onAbort = (): void => settle({ kind: 'abort' });
    abortSignal.addEventListener('abort', onAbort, { once: true });

    if (running.length > 0) {
      updateOutput?.(
        `Waiting for ${running.length} background process(es) to finish…`,
      );
    }

    try {
      return await wakePromise;
    } finally {
      clearTimeout(timer);
      abortSignal.removeEventListener('abort', onAbort);
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    }
  }
}

/**
 * Blocks until something interesting happens: a peer message, a background
 * execution completing, a background shell process exiting, or the wait's own
 * limit. Takes no parameters. When there is genuinely nothing to wait for it
 * returns immediately and says so — a silent hang is the failure mode this
 * tool exists to avoid.
 *
 * Parallel-batch safety: every invocation is an independent observer. It holds
 * no lock, consumes no shared queue, and mutates no shared state that another
 * wait reads to decide whether to return — the only shared state is the
 * message-window ladder, which only ever changes a duration. Two waits issued
 * in the same batch therefore cannot block each other: each wakes on its own
 * copy of the same events, and each tears down its own listeners in `finally`.
 */
export class WaitTool extends BaseDeclarativeTool<WaitToolParams, ToolResult> {
  static readonly Name = 'wait';

  constructor(
    private readonly context: AgentLoopContext,
    messageBus: MessageBus,
  ) {
    super(
      WaitTool.Name,
      'Wait',
      'Blocks until a peer message arrives, a background execution completes, or a background shell process exits. Takes no parameters. Returns immediately when there is nothing to wait for.',
      Kind.Other,
      {
        type: 'object',
        properties: {},
      },
      messageBus,
    );
  }

  protected createInvocation(
    params: WaitToolParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<WaitToolParams, ToolResult> {
    return new WaitToolInvocation(
      this.context,
      params,
      messageBus,
      toolName,
      toolDisplayName,
    );
  }
}
