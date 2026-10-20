/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentEvent,
  Config,
  ContentPart,
  DisplayContent,
} from '@google/gemini-cli-core';
import {
  LegacyAgentSession,
  debugLogger,
  displayContentToString,
} from '@google/gemini-cli-core';
import type { LoadedSettings } from '../config/settings.js';
import type { ServerEvent, WebAttachment, WebToolCall } from './protocol.js';

/** Whether a value is a styled token of a terminal line. */
function isTextToken(value: unknown): value is { text: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'text' in value &&
    typeof value.text === 'string'
  );
}

/** How much of a tool's output to send before truncating. */
const MAX_TOOL_OUTPUT = 64 * 1024;

/** How much of an error message to send. */
const MAX_ERROR_LENGTH = 2000;

/**
 * How long the agent may stay silent before the turn is cut short.
 *
 * Silence means the agent is waiting for something that is not coming: a
 * confirmation nobody will answer, or a tool that will never return. A
 * turn that hangs forever leaves the browser spinning, so it is stopped
 * instead.
 */
const MAX_TURN_SILENCE = 10 * 60 * 1000;

/** How long a turn may run, however busy it is. */
const MAX_TURN_DURATION = 60 * 60 * 1000;

/**
 * A browser client attached to a session.
 */
export interface WebClient {
  send(event: ServerEvent): void;
}

/**
 * The part of the agent session the web UI drives.
 *
 * The real agent is used in production. The tests bring their own, so a
 * turn can be started, watched and abandoned without a model behind it.
 */
export interface WebAgent {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  send(request: { message: { content: ContentPart[] } }): Promise<unknown>;
  abort(): Promise<void>;
}

/** Builds the agent a session drives. */
export type WebAgentFactory = () => WebAgent | Promise<WebAgent>;

/**
 * Drives one agent session and translates its events for the browser.
 *
 * The session owns the agentic loop; this class only observes the events it
 * emits and forwards the interesting ones. That keeps the web behaviour
 * identical to the terminal's, because it is the same loop underneath.
 */
export class WebSession {
  private readonly clients = new Set<WebClient>();
  private agent: WebAgent | undefined;
  private unsubscribe: (() => void) | undefined;
  private currentToolCalls = new Map<string, WebToolCall>();
  private toolStartedAt = new Map<string, number>();
  /** The text of the message being streamed, so chunks accumulate. */
  private messageBuffer = '';
  /** Resolves when the agent ends the current turn. */
  private turnFinished: (() => void) | undefined;
  private cancelled = false;
  /** Whether a turn is in flight. */
  private running = false;
  /** Fires when the agent has been silent for too long. */
  private silenceTimer: NodeJS.Timeout | undefined;
  /** Fires when the turn has run for too long. */
  private turnTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly config: Config,
    readonly settings: LoadedSettings,
    readonly cwd: string,
    private readonly createAgent: WebAgentFactory = () =>
      new LegacyAgentSession({
        config: this.config,
        promptId: this.config.getSessionId(),
      }),
  ) {}

  get sessionId(): string {
    return this.config.getSessionId();
  }

  addClient(client: WebClient): void {
    this.clients.add(client);
  }

  removeClient(client: WebClient): void {
    this.clients.delete(client);
    if (this.clients.size === 0 && this.running) {
      // Nobody is left to answer a confirmation, so the turn is stopped
      // rather than left waiting for an answer that will never come.
      void this.cancel();
    }
  }

  private emit(event: ServerEvent): void {
    for (const client of this.clients) {
      try {
        client.send(event);
      } catch (error) {
        debugLogger.warn('web: failed to send event to client:', error);
      }
    }
  }

  /**
   * Creates the agent session and subscribes to its events.
   *
   * This is deferred until the first prompt: a browser connecting to the UI
   * should be able to list commands and settings even if the agent itself
   * cannot be constructed.
   */
  private async ensureAgent(): Promise<WebAgent> {
    if (this.agent) {
      return this.agent;
    }
    // The client needs a chat before it can answer anything.
    const client = this.config.getGeminiClient();
    if (!client.isInitialized()) {
      await client.initialize();
    }
    const agent = await this.createAgent();
    this.agent = agent;
    this.unsubscribe = agent.subscribe((event) => {
      this.handleEvent(event);
    });
    return agent;
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clearWatchdogs();
    await this.agent?.abort();
    // Nothing is left to wait for, so an open turn is released.
    this.turnFinished?.();
    this.agent = undefined;
    this.clients.clear();
  }

  /** Sends a prompt to the agent. */
  async send(text: string, attachments: WebAttachment[] = []): Promise<void> {
    if (this.running) {
      // Two turns at once would fight over the same agent: the second one
      // would take over the ending of the first, and the first would never
      // be told it was over.
      this.emit({
        type: 'error',
        message:
          'A turn is already running. Stop it before sending another prompt.',
      });
      return;
    }
    this.running = true;
    this.cancelled = false;
    this.messageBuffer = '';
    this.emit({
      type: 'user_message',
      text,
      timestamp: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    this.emit({ type: 'turn_started' });

    // The agent runs its loop in the background, so `send` returns before the
    // model has answered. The turn ends when the agent says so.
    const finished = new Promise<void>((resolve) => {
      this.turnFinished = resolve;
    });

    this.armWatchdogs();

    try {
      const agent = await this.ensureAgent();
      await agent.send({
        message: { content: this.buildContent(text, attachments) },
      });
      await finished;
    } catch (error) {
      this.emit({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      this.clearWatchdogs();
      this.running = false;
      this.turnFinished = undefined;
      this.emit({ type: 'turn_ended', cancelled: this.cancelled });
    }
  }

  /**
   * Builds the content of a message from its text and its attachments.
   *
   * An image travels as inline data, which the model reads directly. Any
   * other file is referenced by its path, so the agent reads it with the
   * tools it already has, exactly as it would for an `@file` reference in
   * the terminal.
   */
  private buildContent(
    text: string,
    attachments: WebAttachment[],
  ): ContentPart[] {
    const content: ContentPart[] = [{ type: 'text', text }];

    for (const attachment of attachments) {
      if (attachment.data && attachment.mimeType.startsWith('image/')) {
        content.push({
          type: 'media',
          data: attachment.data,
          mimeType: attachment.mimeType,
        });
        continue;
      }
      if (attachment.path) {
        content.push({
          type: 'reference',
          text: `Attached file: ${attachment.name} (${attachment.path})`,
          uri: attachment.path,
        });
        continue;
      }
      // A file with content but no path and no image: the model reads it
      // from the text, so the name is all it needs.
      content.push({
        type: 'reference',
        text: `Attached file: ${attachment.name}`,
      });
    }

    return content;
  }

  /** Stops the current turn. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    try {
      await this.agent?.abort();
    } finally {
      // The turn is released even when the agent never says it is done, so
      // the browser does not wait for an answer that will not come.
      this.turnFinished?.();
    }
  }

  /**
   * Arms the timers that stop a turn that is not going anywhere.
   *
   * The silence timer is rearmed on every event the agent sends, so it
   * only fires when the agent has really gone quiet.
   */
  private armWatchdogs(): void {
    this.clearWatchdogs();
    this.armSilenceTimer();
    this.turnTimer = setTimeout(() => {
      this.emit({
        type: 'error',
        message: 'The turn ran for too long and was stopped.',
      });
      void this.cancel();
    }, MAX_TURN_DURATION);
    this.turnTimer.unref?.();
  }

  /** Rearms the silence timer. */
  private armSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }
    this.silenceTimer = setTimeout(() => {
      this.emit({
        type: 'error',
        message:
          'The agent stopped responding, so the turn was stopped. It may be waiting for something that never arrived.',
      });
      void this.cancel();
    }, MAX_TURN_SILENCE);
    this.silenceTimer.unref?.();
  }

  /** Stops the timers that watch over the turn. */
  private clearWatchdogs(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = undefined;
    }
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = undefined;
    }
  }

  private handleEvent(event: AgentEvent): void {
    // The agent is alive, so the silence timer starts over.
    if (this.running) {
      this.armSilenceTimer();
    }
    switch (event.type) {
      case 'message': {
        if (event.role === 'user') {
          return;
        }
        for (const part of event.content) {
          if (part.type === 'text') {
            // The model streams text in chunks; the browser merges them into
            // one bubble, so the whole message is sent each time.
            this.messageBuffer += part.text;
            this.emit({
              type: 'agent_message',
              text: this.messageBuffer,
              streaming: true,
            });
          } else if (part.type === 'thought') {
            this.emit({ type: 'agent_thought', text: part.thought });
          }
        }
        break;
      }
      case 'tool_request': {
        const callId = event.requestId;
        const toolCall: WebToolCall = {
          callId,
          name: event.name,
          title: event.display?.name || event.name,
          args: event.args ?? {},
          status: 'executing',
          kind: event._meta?.legacyState?.kind,
        };
        this.currentToolCalls.set(callId, toolCall);
        this.toolStartedAt.set(callId, Date.now());
        this.emit({ type: 'tool_call', toolCall });
        break;
      }
      case 'tool_update': {
        const callId = event.requestId;
        const existing = this.currentToolCalls.get(callId);
        const status = event._meta?.legacyState?.status;
        const updated: WebToolCall = {
          callId,
          name: existing?.name ?? event.display?.name ?? 'tool',
          title: event.display?.name || existing?.title || 'tool',
          args: existing?.args ?? {},
          status:
            status === 'success'
              ? 'completed'
              : status === 'error'
                ? 'failed'
                : (existing?.status ?? 'executing'),
          kind: existing?.kind,
        };
        this.currentToolCalls.set(callId, updated);
        this.emit({ type: 'tool_call', toolCall: updated });

        // A long-running tool reports its output as it goes; the browser
        // shows it live instead of waiting for the tool to finish.
        const liveOutput = this.liveOutput(event.display?.result);
        if (liveOutput) {
          this.emit({
            type: 'tool_progress',
            callId,
            output: liveOutput,
            message: event._meta?.legacyState?.progressMessage,
          });
        }
        break;
      }
      case 'tool_response': {
        const callId = event.requestId;
        const started = this.toolStartedAt.get(callId);
        const toolCall: WebToolCall = {
          callId,
          name: event.name,
          title:
            this.currentToolCalls.get(callId)?.title ??
            event.display?.name ??
            event.name,
          args: this.currentToolCalls.get(callId)?.args ?? {},
          status: event.isError ? 'failed' : 'completed',
          kind: this.currentToolCalls.get(callId)?.kind,
          durationMs: started ? Date.now() - started : undefined,
        };
        this.currentToolCalls.set(callId, toolCall);
        this.emit({ type: 'tool_call', toolCall });

        const output = this.renderToolOutput(event);
        if (output) {
          this.emit({
            type: 'tool_output',
            callId,
            output: output.text,
            truncated: output.truncated,
            kind: output.kind,
          });
        }
        break;
      }
      case 'usage': {
        const input = event.inputTokens ?? 0;
        const output = event.outputTokens ?? 0;
        const cached = event.cachedTokens ?? 0;
        this.emit({
          type: 'usage',
          usage: {
            input,
            output,
            cached,
            thought: 0,
            total: input + output,
          },
        });
        break;
      }
      case 'error': {
        this.emit({
          type: 'error',
          message: this.readableError(event.message),
        });
        break;
      }
      case 'session_update': {
        if (event.model) {
          this.emit({ type: 'info', message: `Model: ${event.model}` });
        }
        break;
      }
      case 'agent_end': {
        // Close the streamed message so the browser stops merging chunks.
        if (this.messageBuffer) {
          this.emit({
            type: 'agent_message',
            text: this.messageBuffer,
            streaming: false,
          });
        }
        this.messageBuffer = '';
        this.turnFinished?.();
        break;
      }
      default:
        break;
    }
  }

  /**
   * Turns an error payload into something a person can read.
   *
   * The API reports failures as a JSON envelope; showing that raw in the
   * browser is unreadable, so the innermost message is picked out and
   * capped, because a failed call can carry a whole tool schema.
   */
  private readableError(message: string): string {
    const trimmed = message.trim();
    const extract = (raw: string): string | undefined => {
      if (!raw.trimStart().startsWith('{')) {
        return undefined;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !('error' in parsed)) {
          return undefined;
        }
        const error = parsed.error;
        if (
          !error ||
          typeof error !== 'object' ||
          !('message' in error) ||
          typeof error.message !== 'string'
        ) {
          return undefined;
        }
        return error.message;
      } catch {
        return undefined;
      }
    };

    const inner = extract(trimmed);
    const text = inner ?? trimmed;
    const innerInner = inner ? extract(inner) : undefined;
    const final = innerInner ?? text;

    return final.length > MAX_ERROR_LENGTH
      ? `${final.slice(0, MAX_ERROR_LENGTH)}…`
      : final;
  }

  /**
   * Renders a tool's result for the browser.
   *
   * The terminal shows these in a box; the browser wants text, so a diff
   * becomes a unified diff and a terminal result becomes its output.
   */
  private renderToolOutput(
    event: Extract<AgentEvent, { type: 'tool_response' }>,
  ): { text: string; truncated: boolean; kind?: 'diff' } | undefined {
    const display = event.display;
    if (display?.result) {
      const result = display.result;
      if (result.type === 'text') {
        return this.truncate(this.readableText(result.text));
      }
      if (result.type === 'diff') {
        const path = result.path ? `--- ${result.path}\n` : '';
        return {
          ...this.truncate(
            `${path}${this.unifiedDiff(result.beforeText, result.afterText)}`,
          ),
          kind: 'diff',
        };
      }
      if (result.type === 'terminal' && result.ansi) {
        // AnsiOutput is a list of lines, each a list of styled tokens.
        const text = result.ansi
          .map((line) => line.map((token) => token.text).join(''))
          .join('\n')
          .trimEnd();
        if (text.length > 0) {
          return this.truncate(text);
        }
      }
      if (result.type === 'terminal' && result.exitCode !== undefined) {
        const code = result.exitCode === 0 ? 'ok' : `exit ${result.exitCode}`;
        return this.truncate(`Command finished: ${code}`);
      }
    }

    const text = (event.content ?? [])
      .filter(
        (part): part is Extract<ContentPart, { type: 'text' }> =>
          part.type === 'text',
      )
      .map((part) => this.readableText(part.text))
      .join('\n');

    return text ? this.truncate(text) : undefined;
  }

  /**
   * Turns a serialized terminal output back into the text it showed.
   *
   * Older tool results carry their styled lines as JSON, because there was
   * nowhere in the display to put a terminal. Showing that raw is how a
   * shell result ends up looking like `[[{"text":"..."}]]`.
   */
  private readableText(text: string): string {
    if (!text.startsWith('[[')) {
      return text;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed) || !parsed.every(Array.isArray)) {
        return text;
      }
      return parsed
        .map((line) =>
          Array.isArray(line)
            ? line
                .map((token) => (isTextToken(token) ? token.text : ''))
                .join('')
            : '',
        )
        .join('\n');
    } catch {
      return text;
    }
  }

  /**
   * The text of a tool's display while it is still running.
   *
   * A terminal result is a list of styled lines, which the browser wants
   * as plain text rather than as the JSON it would otherwise be.
   */
  private liveOutput(
    result: DisplayContent | null | undefined,
  ): string | undefined {
    if (!result) {
      return undefined;
    }
    if (result.type === 'terminal' && result.ansi) {
      return result.ansi
        .map((line) => line.map((token) => token.text).join(''))
        .join('\n');
    }
    if (result.type === 'terminal' && result.exitCode !== undefined) {
      return undefined;
    }
    return displayContentToString(result);
  }

  private truncate(text: string): { text: string; truncated: boolean } {
    if (text.length <= MAX_TOOL_OUTPUT) {
      return { text, truncated: false };
    }
    return {
      text: text.slice(0, MAX_TOOL_OUTPUT),
      truncated: true,
    };
  }

  /**
   * A unified diff of two texts.
   *
   * The browser renders it line by line, so the diff only needs the changed
   * lines with a little context around them.
   */
  private unifiedDiff(before: string, after: string): string {
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');

    // Longest common subsequence, so the diff points at the real changes
    // rather than at a shift in the line numbers.
    const lcs: number[][] = Array.from({ length: beforeLines.length + 1 }, () =>
      new Array<number>(afterLines.length + 1).fill(0),
    );
    for (let i = beforeLines.length - 1; i >= 0; i--) {
      for (let j = afterLines.length - 1; j >= 0; j--) {
        lcs[i][j] =
          beforeLines[i] === afterLines[j]
            ? lcs[i + 1][j + 1] + 1
            : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }

    const lines: string[] = [];
    let i = 0;
    let j = 0;
    while (i < beforeLines.length && j < afterLines.length) {
      if (beforeLines[i] === afterLines[j]) {
        lines.push(` ${beforeLines[i]}`);
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        lines.push(`-${beforeLines[i]}`);
        i++;
      } else {
        lines.push(`+${afterLines[j]}`);
        j++;
      }
    }
    while (i < beforeLines.length) {
      lines.push(`-${beforeLines[i++]}`);
    }
    while (j < afterLines.length) {
      lines.push(`+${afterLines[j++]}`);
    }

    return lines.join('\n');
  }
}
