/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renders a ConversationRecord as a readable Markdown transcript — the
 * "pretty" counterpart of the raw JSON session export.
 *
 * The default is a quiet, conversation-first transcript: user and assistant
 * text verbatim, tool calls grouped into a single compact collapsible block
 * per turn (name, one-line argument hint, status glyph), errors kept as
 * blockquotes. `full` opts into the complete trace: per-tool arguments and
 * results, thinking excerpts, per-turn token usage, and every CLI notice.
 */
import {
  CoreToolCallStatus,
  type Status,
  type ConversationRecord,
  type MessageRecord,
  type ToolCallRecord,
} from '@google/gemini-cli-core';

export interface RenderOptions {
  /** Include the complete trace (tool args/results, thoughts, tokens, notices). */
  full?: boolean;
}

/** Longest pretty-printed tool arguments block before truncation (full mode). */
const MAX_ARGS_CHARS = 1200;
/** Longest tool result excerpt before truncation (full mode). */
const MAX_RESULT_CHARS = 4000;
/** Longest single thought excerpt before truncation (full mode). */
const MAX_THOUGHT_CHARS = 1000;
/** Most tool-call lines listed per turn in quiet mode. */
const MAX_QUIET_TOOL_LINES = 20;
/** Longest argument hint in a quiet-mode tool line. */
const MAX_ARG_HINT_CHARS = 60;

/** Argument keys worth surfacing as the one-line hint, in priority order. */
const ARG_HINT_KEYS = [
  'query',
  'path',
  'file_path',
  'filePath',
  'url',
  'command',
  'pattern',
  'prompt',
  'description',
];

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

/** One-line argument hint for a quiet-mode tool line. */
function summarizeCallArgs(call: ToolCallRecord): string {
  for (const key of ARG_HINT_KEYS) {
    const value: unknown = call.args[key];
    if (typeof value === 'string' && value.trim()) {
      return truncate(value.trim().replace(/\s+/g, ' '), MAX_ARG_HINT_CHARS);
    }
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function statusGlyph(status: Status): string {
  switch (status) {
    case CoreToolCallStatus.Success:
      return '✓';
    case CoreToolCallStatus.Error:
      return '❌';
    case CoreToolCallStatus.Cancelled:
      return '⊘';
    default:
      return '·';
  }
}

/** Quiet mode: all of a turn's tool calls as one compact collapsible list. */
function renderQuietToolBlock(calls: ToolCallRecord[]): string | undefined {
  if (calls.length === 0) return undefined;
  const label =
    calls.length === 1 ? '1 tool call' : `${calls.length} tool calls`;
  const lines = ['<details>', `<summary>🔧 ${label}</summary>`, ''];
  const shown = calls.slice(0, MAX_QUIET_TOOL_LINES);
  for (const call of shown) {
    const hint = summarizeCallArgs(call);
    lines.push(
      `- \`${call.name}\`${hint ? ` — ${hint}` : ''} ${statusGlyph(call.status)}`,
    );
  }
  if (calls.length > shown.length) {
    lines.push(`- … +${calls.length - shown.length} more`);
  }
  lines.push('', '</details>');
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
 * Internal setup blocks injected as the first user turn (environment/date/
 * directory-tree context, loaded extension/MCP instructions). Same convention
 * as core's isIgnoredUserContent: not conversation, so the export skips them
 * (quiet) or folds them away (full) instead of dumping pages of directory
 * listings into the transcript.
 */
const SETUP_CONTEXT_TAGS = [
  '<session_context>',
  '<loaded_context>',
  '<hook_context>',
];

function isSetupContextText(text: string): boolean {
  const head = text.slice(0, 100);
  return SETUP_CONTEXT_TAGS.some((tag) => head.includes(tag));
}

function renderSetupContext(text: string): string {
  return [
    '<details>',
    '<summary>⚙️ Session context</summary>',
    '',
    truncate(text, MAX_RESULT_CHARS),
    '',
    '</details>',
  ].join('\n');
}

/**
 * Render a session's conversation record as a Markdown transcript.
 * Quiet by default; see {@link RenderOptions.full} for the complete trace.
 */
export function renderSessionMarkdown(
  record: ConversationRecord,
  options: RenderOptions = {},
): string {
  const full = options.full === true;
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
      if (isSetupContextText(text)) {
        // Quiet mode drops setup context entirely; full mode folds it.
        if (full) out.push(renderSetupContext(text), '');
        continue;
      }
      out.push('## User', time, '', text, '');
      renderedAny = true;
      continue;
    }

    if (message.type === 'gemini') {
      const thoughts = full ? renderThoughts(message) : undefined;
      const tokensLine = full ? renderTokensLine(message) : undefined;
      const toolCalls = message.toolCalls ?? [];
      const toolBlocks = full
        ? toolCalls.map(renderToolCall)
        : (() => {
            const block = renderQuietToolBlock(toolCalls);
            return block ? [block] : [];
          })();
      if (!text && !thoughts && toolBlocks.length === 0) continue;
      out.push('## Assistant', time, '');
      if (thoughts) out.push(thoughts, '');
      if (text) out.push(text, '');
      for (const toolBlock of toolBlocks) out.push(toolBlock, '');
      if (tokensLine) out.push(tokensLine, '');
      renderedAny = true;
      continue;
    }

    // Notices: errors always earn their place; info/warning only in full mode.
    if (text && (full || message.type === 'error')) {
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
