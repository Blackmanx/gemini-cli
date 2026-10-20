/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentEvent, Config, ContentPart } from '@google/gemini-cli-core';
import {
  LegacyAgentSession,
  debugLogger,
  displayContentToString,
} from '@google/gemini-cli-core';
import type { LoadedSettings } from '../config/settings.js';
import type { ServerEvent, WebAttachment, WebToolCall } from './protocol.js';

/** How much of a tool's output to send before truncating. */
const MAX_TOOL_OUTPUT = 64 * 1024;

/** How much of an error message to send. */
const MAX_ERROR_LENGTH = 2000;

/**
 * A browser client attached to a session.
 */
export interface WebClient {
  send(event: ServerEvent): void;
}

/**
 * Drives one agent session and translates its events for the browser.
 *
 * The session owns the agentic loop; this class only observes the events it
 * emits and forwards the interesting ones. That keeps the web behaviour
 * identical to the terminal's, because it is the same loop underneath.
 */
export class WebSession {
  private readonly clients = new Set<WebClient>();
  private agent: LegacyAgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private currentToolCalls = new Map<string, WebToolCall>();
  private toolStartedAt = new Map<string, number>();
  /** The text of the message being streamed, so chunks accumulate. */
  private messageBuffer = '';
  /** Resolves when the agent ends the current turn. */
  private turnFinished: (() => void) | undefined;
  private cancelled = false;

  constructor(
    readonly config: Config,
    readonly settings: LoadedSettings,
    readonly cwd: string,
  ) {}

  get sessionId(): string {
    return this.config.getSessionId();
  }

  addClient(client: WebClient): void {
    this.clients.add(client);
  }

  removeClient(client: WebClient): void {
    this.clients.delete(client);
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
  private async ensureAgent(): Promise<LegacyAgentSession> {
    if (this.agent) {
      return this.agent;
    }
    // The client needs a chat before it can answer anything.
    const client = this.config.getGeminiClient();
    if (!client.isInitialized()) {
      await client.initialize();
    }
    const agent = new LegacyAgentSession({
      config: this.config,
      promptId: this.config.getSessionId(),
    });
    this.agent = agent;
    this.unsubscribe = agent.subscribe((event) => {
      this.handleEvent(event);
    });
    return agent;
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.agent?.abort();
    this.agent = undefined;
    this.clients.clear();
  }

  /** Sends a prompt to the agent. */
  async send(text: string, attachments: WebAttachment[] = []): Promise<void> {
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
    await this.agent?.abort();
  }

  private handleEvent(event: AgentEvent): void {
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
        const liveOutput = displayContentToString(event.display?.result);
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
        return this.truncate(result.text);
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
      if (result.type === 'terminal' && result.exitCode !== undefined) {
        const code = result.exitCode === 0 ? 'ok' : `exit ${result.exitCode}`;
        return this.truncate(`Command finished: ${code}`);
      }
      if (result.type === 'terminal' && result.ansi) {
        // AnsiOutput is a list of lines, each a list of styled tokens.
        const text = result.ansi
          .map((line) => line.map((token) => token.text).join(''))
          .join('\n');
        return this.truncate(text);
      }
    }

    const text = (event.content ?? [])
      .filter(
        (part): part is Extract<ContentPart, { type: 'text' }> =>
          part.type === 'text',
      )
      .map((part) => part.text)
      .join('\n');

    return text ? this.truncate(text) : undefined;
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
