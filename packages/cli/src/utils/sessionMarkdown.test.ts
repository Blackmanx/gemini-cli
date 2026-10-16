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

  it('renders tool calls as collapsible details with args and result', () => {
    const md = renderSessionMarkdown(
      baseRecord({
        messages: [
          {
            id: 'm1',
            timestamp: '2026-10-16T10:00:00.000Z',
            type: 'gemini',
            content: '',
            toolCalls: [
              {
                id: 't1',
                name: 'read_file',
                args: { path: 'a.txt' },
                status: CoreToolCallStatus.Success,
                timestamp: '2026-10-16T10:00:01.000Z',
                result: 'file contents here',
              },
            ],
          },
        ],
      }),
    );

    expect(md).toContain('<details>');
    expect(md).toContain('<summary><code>read_file</code> — success</summary>');
    expect(md).toContain('**Arguments**');
    expect(md).toContain('```json\n{\n  "path": "a.txt"\n}\n```');
    expect(md).toContain('**Result**');
    expect(md).toContain('file contents here');
    expect(md).toContain('</details>');
  });

  it('renders FileDiff-style results as a diff fence', () => {
    const md = renderSessionMarkdown(
      baseRecord({
        messages: [
          {
            id: 'm1',
            timestamp: '2026-10-16T10:00:00.000Z',
            type: 'gemini',
            content: '',
            toolCalls: [
              {
                id: 't1',
                name: 'edit',
                args: {},
                status: CoreToolCallStatus.Success,
                timestamp: '2026-10-16T10:00:01.000Z',
                resultDisplay: {
                  fileName: 'a.txt',
                  filePath: '/tmp/a.txt',
                  fileDiff: '+new line',
                  originalContent: null,
                  newContent: 'new line',
                },
              },
            ],
          },
        ],
      }),
    );

    expect(md).toContain('```diff\n+new line\n```');
  });

  it('truncates long tool results', () => {
    const md = renderSessionMarkdown(
      baseRecord({
        messages: [
          {
            id: 'm1',
            timestamp: '2026-10-16T10:00:00.000Z',
            type: 'gemini',
            content: '',
            toolCalls: [
              {
                id: 't1',
                name: 'read_file',
                args: {},
                status: CoreToolCallStatus.Success,
                timestamp: '2026-10-16T10:00:01.000Z',
                result: 'x'.repeat(5000),
              },
            ],
          },
        ],
      }),
    );

    expect(md).toContain('… (truncated, 1000 more characters)');
  });

  it('renders thoughts collapsed and a tokens line', () => {
    const md = renderSessionMarkdown(
      baseRecord({
        messages: [
          {
            id: 'm1',
            timestamp: '2026-10-16T10:00:00.000Z',
            type: 'gemini',
            content: 'the answer',
            thoughts: [
              {
                timestamp: '2026-10-16T10:00:01.000Z',
                subject: 'Plan',
                description: 'think about it',
              },
            ],
            tokens: { input: 10, output: 5, cached: 3, total: 18 },
          },
        ],
      }),
    );

    expect(md).toContain('<summary>💭 Thinking</summary>');
    expect(md).toContain('**Plan**');
    expect(md).toContain('_Tokens: in 10 · out 5 · cached 3_');
    expect(md).toContain('the answer');
  });

  it('renders info/error/warning messages as blockquotes', () => {
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
            timestamp: '2026-10-16T10:00:01.000Z',
            type: 'error',
            content: 'boom',
          },
          {
            id: 'm3',
            timestamp: '2026-10-16T10:00:02.000Z',
            type: 'warning',
            content: 'careful',
          },
        ],
      }),
    );

    expect(md).toContain('> ℹ️ saved');
    expect(md).toContain('> ❌ boom');
    expect(md).toContain('> ⚠️ careful');
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
