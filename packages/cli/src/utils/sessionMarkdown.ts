/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renders a ConversationRecord as a readable Markdown transcript — the
 * "pretty" counterpart of the raw JSON session export. Session metadata heads
 * the document, tool calls collapse into <details> blocks, thoughts stay
 * available but out of the way, and per-turn token usage is summarized.
 */
import type {
  ConversationRecord,
  MessageRecord,
  ToolCallRecord,
} from '@google/gemini-cli-core';

/** Longest pretty-printed tool arguments block before truncation. */
const MAX_ARGS_CHARS = 1200;
/** Longest tool result excerpt before truncation. */
const MAX_RESULT_CHARS = 4000;
/** Longest single thought excerpt before truncation. */
const MAX_THOUGHT_CHARS = 1000;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (truncated, ${text.length - limit} more characters)`;
}

/**
 * Extract the plain text of a message part list. Non-text parts
 * (function calls/responses, inline data) are skipped.
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(extractText).filter(Boolean).join('\n\n');
  }
  if (typeof content === 'object' && content !== null && 'text' in content) {
    const text: unknown = content['text'];
    if (typeof text === 'string') return text;
  }
  return '';
}

/** Stable, locale-independent timestamp rendering ('YYYY-MM-DD HH:MM:SS'). */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('sv-SE', { hour12: false });
}

function toJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2) ?? undefined;
  } catch {
    // Circular or otherwise unserializable payloads degrade gracefully.
    return undefined;
  }
}

interface FileDiffLike {
  fileDiff: string;
}

function isFileDiffLike(value: unknown): value is FileDiffLike {
  return typeof value === 'object' && value !== null && 'fileDiff' in value;
}

function fencedBlock(language: string, body: string): string {
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

/** Render a tool call's result (display variant preferred) as Markdown. */
function renderToolResult(call: ToolCallRecord): string | undefined {
  const display = call.resultDisplay ?? call.result;
  if (display === null || display === undefined) return undefined;
  if (typeof display === 'string') return display;
  if (isFileDiffLike(display)) return fencedBlock('diff', display.fileDiff);
  const fromParts = Array.isArray(display)
    ? display.map(extractText).filter(Boolean).join('\n\n')
    : extractText(display);
  if (fromParts) return fromParts;
  return toJson(display);
}

function renderToolCall(call: ToolCallRecord): string {
  const lines: string[] = ['<details>'];
  lines.push(`<summary><code>${call.name}</code> — ${call.status}</summary>`);
  lines.push('');
  const args = toJson(call.args);
  if (args) {
    lines.push(
      '**Arguments**',
      '',
      fencedBlock('json', truncate(args, MAX_ARGS_CHARS)),
      '',
    );
  }
  const result = renderToolResult(call);
  if (result) {
    lines.push('**Result**', '', truncate(result, MAX_RESULT_CHARS), '');
  }
  lines.push('</details>');
  return lines.join('\n');
}

function renderThoughts(message: MessageRecord): string | undefined {
  const thoughts = message.type === 'gemini' ? message.thoughts : undefined;
  if (!thoughts || thoughts.length === 0) return undefined;
  const body = thoughts
    .map(
      (thought) =>
        `**${thought.subject}**\n\n${truncate(thought.description, MAX_THOUGHT_CHARS)}`,
    )
    .join('\n\n');
  return [
    '<details>',
    '<summary>💭 Thinking</summary>',
    '',
    body,
    '',
    '</details>',
  ].join('\n');
}

function renderTokensLine(message: MessageRecord): string | undefined {
  const tokens = message.type === 'gemini' ? message.tokens : undefined;
  if (!tokens) return undefined;
  const parts = [
    `in ${tokens.input}`,
    `out ${tokens.output}`,
    `cached ${tokens.cached}`,
  ];
  if (tokens.thoughts !== undefined) parts.push(`thoughts ${tokens.thoughts}`);
  if (tokens.tool !== undefined) parts.push(`tools ${tokens.tool}`);
  return `_Tokens: ${parts.join(' · ')}_`;
}

function blockquote(text: string, icon: string): string[] {
  return text.split('\n').map((line) => `> ${icon} ${line}`);
}

/**
 * Render a session's conversation record as a Markdown transcript.
 */
export function renderSessionMarkdown(record: ConversationRecord): string {
  const out: string[] = ['# Gemini CLI conversation', ''];

  const started = formatTimestamp(record.startTime);
  const updated = formatTimestamp(record.lastUpdated);
  out.push(`- **Session:** \`${record.sessionId}\``);
  out.push(`- **Started:** ${started}`);
  if (updated !== started) out.push(`- **Last updated:** ${updated}`);
  if (record.kind === 'subagent') out.push('- **Kind:** subagent');

  const models = new Set<string>();
  let messageCount = 0;
  for (const message of record.messages) {
    messageCount += 1;
    if (message.type === 'gemini' && message.model) {
      models.add(message.model);
    }
  }
  if (models.size > 0) {
    const label = models.size === 1 ? 'Model' : 'Models';
    out.push(
      `- **${label}:** ${[...models].map((m) => `\`${m}\``).join(', ')}`,
    );
  }
  out.push(`- **Messages:** ${messageCount}`);
  if (record.goal) {
    out.push(
      `- **Goal:** ${record.goal.goal.objective} _(${record.goal.mode})_`,
    );
  }
  out.push('');

  if (record.summary) {
    out.push(...blockquote(record.summary, '📌'), '');
  }

  out.push('---', '');

  let renderedAny = false;
  for (const message of record.messages) {
    const text = extractText(message.content).trim();
    const time = `<sub>${formatTimestamp(message.timestamp)}</sub>`;

    if (message.type === 'user') {
      if (!text) continue;
      out.push('## User', time, '', text, '');
      renderedAny = true;
      continue;
    }

    if (message.type === 'gemini') {
      const thoughts = renderThoughts(message);
      const toolCalls = (message.toolCalls ?? []).map(renderToolCall);
      const tokensLine = renderTokensLine(message);
      if (!text && !thoughts && toolCalls.length === 0) continue;
      out.push('## Assistant', time, '');
      if (thoughts) out.push(thoughts, '');
      if (text) out.push(text, '');
      for (const toolCall of toolCalls) out.push(toolCall, '');
      if (tokensLine) out.push(tokensLine, '');
      renderedAny = true;
      continue;
    }

    if (text) {
      const icon =
        message.type === 'error'
          ? '❌'
          : message.type === 'warning'
            ? '⚠️'
            : 'ℹ️';
      out.push(...blockquote(text, icon), '');
      renderedAny = true;
    }
  }

  if (!renderedAny) {
    out.push('_This session has no messages._', '');
  }

  return `${out.join('\n').trimEnd()}\n`;
}
