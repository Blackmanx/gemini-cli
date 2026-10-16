/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { renderSessionMarkdown } from './sessionMarkdown.js';
import { CoreToolCallStatus } from '@google/gemini-cli-core';
import type {
  ConversationRecord,
  MessageRecord,
  ToolCallRecord,
} from '@google/gemini-cli-core';

const baseRecord = (
  overrides: Partial<ConversationRecord> = {},
): ConversationRecord => ({
  sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  projectHash: 'project-hash',
  startTime: '2026-10-16T10:00:00.000Z',
  lastUpdated: '2026-10-16T10:05:00.000Z',
  messages: [],
  ...overrides,
});

const geminiMessage = (overrides: Partial<MessageRecord>): MessageRecord =>
  ({
    id: 'm1',
    timestamp: '2026-10-16T10:00:00.000Z',
    type: 'gemini',
    content: '',
    ...overrides,
  }) as unknown as MessageRecord;

const toolCall = (overrides: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  id: 't1',
  name: 'read_file',
  args: { path: 'a.txt' },
  status: CoreToolCallStatus.Success,
  timestamp: '2026-10-16T10:00:01.000Z',
  ...overrides,
});

describe('renderSessionMarkdown', () => {
  it('renders the metadata header', () => {
    const md = renderSessionMarkdown(
      baseRecord({
        kind: 'subagent',
        summary: 'We looked at the thing.',
        messages: [
          {
            id: 'm1',
            timestamp: '2026-10-16T10:00:00.000Z',
            type: 'user',
            content: 'hi',
          },
          {
            id: 'm2',
            timestamp: '2026-10-16T10:01:00.000Z',
            type: 'gemini',
            content: 'hello',
            model: 'gemini-3.1-flash-lite',
          },
        ],
      }),
    );

    expect(md).toContain('# Gemini CLI conversation');
    expect(md).toContain(
      `- **Session:** \`aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\``,
    );
    expect(md).toContain('- **Kind:** subagent');
    expect(md).toContain('- **Model:** `gemini-3.1-flash-lite`');
    expect(md).toContain('- **Messages:** 2');
    expect(md).toContain('> 📌 We looked at the thing.');
    expect(md).toContain('## User');
    expect(md).toContain('## Assistant');
    expect(md).toContain('hello');
  });

  it('renders the goal in the header', () => {
    const md = renderSessionMarkdown(
      baseRecord({
        goal: {
          mode: 'goal',
          goal: {
            id: 'g1',
            objective: 'Ship the release',
            status: 'active',
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 0,
            updatedAt: 0,
          },
        },
      }),
    );
    expect(md).toContain('- **Goal:** Ship the release _(goal)_');
  });

  describe('quiet mode (default)', () => {
    it("groups a turn's tool calls into one compact collapsible list", () => {
      const md = renderSessionMarkdown(
        baseRecord({
          messages: [
            geminiMessage({
              content: 'working on it',
              toolCalls: [
                toolCall({ name: 'read_file', args: { path: 'a.txt' } }),
                toolCall({
                  id: 't2',
                  name: 'run_shell_command',
                  args: { command: 'npm test' },
                  status: CoreToolCallStatus.Error,
                }),
              ],
            }),
          ],
        }),
      );

      expect(md).toContain('<summary>🔧 2 tool calls</summary>');
      expect(md).toContain('`read_file` — a.txt ✓');
      expect(md).toContain('`run_shell_command` — npm test ❌');
      expect(md).not.toContain('**Arguments**');
      expect(md).not.toContain('**Result**');
      // One details block for the whole turn, not one per call.
      expect(md.match(/<details>/g)).toHaveLength(1);
      expect(md).toContain('working on it');
    });

    it('caps long tool-call lists', () => {
      const calls = Array.from({ length: 25 }, (_, i) =>
        toolCall({ id: `t${i}`, args: { path: `f${i}.txt` } }),
      );
      const md = renderSessionMarkdown(
        baseRecord({ messages: [geminiMessage({ toolCalls: calls })] }),
      );

      expect(md).toContain('- … +5 more');
    });

    it('drops internal session-context setup messages (directory tree dumps)', () => {
      const setup =
        '<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\n/tmp Directory Structure:\nShowing up to 200 items...\n</session_context>';
      const md = renderSessionMarkdown(
        baseRecord({
          messages: [
            {
              id: 'm1',
              timestamp: '2026-10-16T09:44:17.000Z',
              type: 'user',
              content: setup,
            },
            {
              id: 'm2',
              timestamp: '2026-10-16T09:45:00.000Z',
              type: 'user',
              content: 'real question',
            },
          ],
        }),
      );

      expect(md).not.toContain('Directory Structure');
      expect(md).toContain('real question');
      expect(md.match(/## User/g)).toHaveLength(1);
    });

    it('drops loaded-context blocks even behind a --- separator', () => {
      const md = renderSessionMarkdown(
        baseRecord({
          messages: [
            {
              id: 'm1',
              timestamp: '2026-10-16T09:44:17.000Z',
              type: 'user',
              content:
                '---\n\n<loaded_context>\n<project_context>MCP server instructions</project_context>\n</loaded_context>',
            },
          ],
        }),
      );

      expect(md).not.toContain('MCP server instructions');
      expect(md).toContain('_This session has no messages._');
    });

    it('hides thoughts, tokens, tool outputs and info/warning notices', () => {
      const md = renderSessionMarkdown(
        baseRecord({
          messages: [
            geminiMessage({
              content: 'the answer',
              thoughts: [
                {
                  timestamp: '2026-10-16T10:00:01.000Z',
                  subject: 'Plan',
                  description: 'think about it',
                },
              ],
              toolCalls: [toolCall({ result: 'noisy output' })],
              tokens: { input: 10, output: 5, cached: 3, total: 18 },
            }),
            {
              id: 'm2',
              timestamp: '2026-10-16T10:02:00.000Z',
              type: 'info',
              content: 'saved',
            },
            {
              id: 'm3',
              timestamp: '2026-10-16T10:03:00.000Z',
              type: 'warning',
              content: 'careful',
            },
            {
              id: 'm4',
              timestamp: '2026-10-16T10:04:00.000Z',
              type: 'error',
              content: 'boom',
            },
          ],
        }),
      );

      expect(md).toContain('the answer');
      expect(md).not.toContain('💭 Thinking');
      expect(md).not.toContain('_Tokens:');
      expect(md).not.toContain('noisy output');
      expect(md).not.toContain('ℹ️ saved');
      expect(md).not.toContain('⚠️ careful');
      // Errors still earn their place.
      expect(md).toContain('> ❌ boom');
    });
  });

  describe('full mode', () => {
    it('renders tool calls with args and result', () => {
      const md = renderSessionMarkdown(
        baseRecord({
          messages: [
            geminiMessage({
              toolCalls: [
                toolCall({
                  name: 'read_file',
                  args: { path: 'a.txt' },
                  result: 'file contents here',
                }),
              ],
            }),
          ],
        }),
        { full: true },
      );

      expect(md).toContain(
        '<summary><code>read_file</code> — success</summary>',
      );
      expect(md).toContain('**Arguments**');
      expect(md).toContain('```json\n{\n  "path": "a.txt"\n}\n```');
      expect(md).toContain('**Result**');
      expect(md).toContain('file contents here');
    });

    it('renders FileDiff-style results as a diff fence', () => {
      const md = renderSessionMarkdown(
        baseRecord({
          messages: [
            geminiMessage({
              toolCalls: [
                toolCall({
                  name: 'edit',
                  args: {},
                  resultDisplay: {
                    fileName: 'a.txt',
                    filePath: '/tmp/a.txt',
                    fileDiff: '+new line',
                    originalContent: null,
                    newContent: 'new line',
                  },
                }),
              ],
            }),
          ],
        }),
        { full: true },
      );

      expect(md).toContain('```diff\n+new line\n```');
    });

    it('truncates long tool results', () => {
      const md = renderSessionMarkdown(
        baseRecord({
          messages: [
            geminiMessage({
              toolCalls: [toolCall({ args: {}, result: 'x'.repeat(5000) })],
            }),
          ],
        }),
        { full: true },
      );

      expect(md).toContain('… (truncated, 1000 more characters)');
    });

    it('renders thoughts collapsed and a tokens line', () => {
      const md = renderSessionMarkdown(
        baseRecord({
          messages: [
            geminiMessage({
              content: 'the answer',
              thoughts: [
                {
                  timestamp: '2026-10-16T10:00:01.000Z',
                  subject: 'Plan',
                  description: 'think about it',
                },
              ],
              tokens: { input: 10, output: 5, cached: 3, total: 18 },
            }),
          ],
        }),
        { full: true },
      );

      expect(md).toContain('<summary>💭 Thinking</summary>');
      expect(md).toContain('**Plan**');
      expect(md).toContain('_Tokens: in 10 · out 5 · cached 3_');
      expect(md).toContain('the answer');
    });

    it('folds setup context into a collapsed block', () => {
      const md = renderSessionMarkdown(
        baseRecord({
          messages: [
            {
              id: 'm1',
              timestamp: '2026-10-16T09:44:17.000Z',
              type: 'user',
              content:
                '<session_context>\n/tmp Directory Structure: Showing up to 200 items...\n</session_context>',
            },
          ],
        }),
        { full: true },
      );

      expect(md).toContain('<summary>⚙️ Session context</summary>');
      expect(md).toContain('Directory Structure');
      expect(md).not.toContain('## User');
    });

    it('renders info and warning notices as blockquotes', () => {
      const md = renderSessionMarkdown(
        baseRecord({
          messages: [
            {
              id: 'm1',
              timestamp: '2026-10-16T10:00:00.000Z',
              type: 'info',
              content: 'saved',
            },
            {
              id: 'm2',
              timestamp: '2026-10-16T10:00:02.000Z',
              type: 'warning',
              content: 'careful',
            },
          ],
        }),
        { full: true },
      );

      expect(md).toContain('> ℹ️ saved');
      expect(md).toContain('> ⚠️ careful');
    });
  });

  it('skips empty messages and non-text parts', () => {
    const md = renderSessionMarkdown(
      baseRecord({
        messages: [
          {
            id: 'm1',
            timestamp: '2026-10-16T10:00:00.000Z',
            type: 'user',
            content: '',
          },
          {
            id: 'm2',
            timestamp: '2026-10-16T10:00:01.000Z',
            type: 'gemini',
            content: [
              { functionCall: { name: 'read_file', args: {} } },
              { text: 'only this part' },
            ] as MessageRecord['content'],
          },
        ],
      }),
    );

    expect(md).not.toContain('## User');
    expect(md).toContain('only this part');
    expect(md).not.toContain('functionCall');
  });

  it('notes empty conversations', () => {
    const md = renderSessionMarkdown(baseRecord());
    expect(md).toContain('_This session has no messages._');
  });
});
