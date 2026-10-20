/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { WebSession } from './webSession.js';
import type { Config, ContentPart } from '@google/gemini-cli-core';
import type { LoadedSettings } from '../config/settings.js';
import type { ServerEvent, WebAttachment } from './protocol.js';

const config = {
  getSessionId: () => 'test-session',
  getGeminiClient: () => ({ isInitialized: () => true }),
} as unknown as Config;

const settings = {} as LoadedSettings;

describe('WebSession', () => {
  it('renders a diff as a unified diff', async () => {
    const session = new WebSession(config, settings, '/tmp');
    const events: ServerEvent[] = [];
    session.addClient({ send: (event) => events.push(event) });

    // Reach the private renderer through the event path: a tool response
    // whose display carries a diff.
    const handler = (
      session as unknown as {
        handleEvent(event: unknown): void;
      }
    ).handleEvent.bind(session);

    handler({
      type: 'tool_response',
      requestId: 'call_1',
      name: 'write_file',
      display: {
        name: 'WriteFile',
        result: {
          type: 'diff',
          path: '/tmp/demo.txt',
          beforeText: 'hola\nmundo\n',
          afterText: 'adios\nmundo\n',
        },
      },
      content: [],
    });

    const output = events.find((event) => event.type === 'tool_output');
    expect(output).toBeDefined();
    if (output?.type !== 'tool_output') {
      throw new Error('no tool output');
    }
    expect(output.kind).toBe('diff');
    expect(output.output).toContain('--- /tmp/demo.txt');
    expect(output.output).toContain('-hola');
    expect(output.output).toContain('+adios');
    expect(output.output).toContain(' mundo');
  });

  it('truncates very long tool output', async () => {
    const session = new WebSession(config, settings, '/tmp');
    const events: ServerEvent[] = [];
    session.addClient({ send: (event) => events.push(event) });

    const handler = (
      session as unknown as { handleEvent(event: unknown): void }
    ).handleEvent.bind(session);

    handler({
      type: 'tool_response',
      requestId: 'call_2',
      name: 'read_file',
      display: {
        name: 'ReadFile',
        result: { type: 'text', text: 'x'.repeat(200_000) },
      },
      content: [],
    });

    const output = events.find((event) => event.type === 'tool_output');
    expect(output).toBeDefined();
    if (output?.type !== 'tool_output') {
      throw new Error('no tool output');
    }
    expect(output.truncated).toBe(true);
    expect(output.output.length).toBeLessThan(100_000);
  });

  it('streams the output of a tool that is still running', () => {
    const session = new WebSession(config, settings, '/tmp');
    const events: ServerEvent[] = [];
    session.addClient({ send: (event) => events.push(event) });

    const handler = (
      session as unknown as { handleEvent(event: unknown): void }
    ).handleEvent.bind(session);

    handler({
      type: 'tool_update',
      requestId: 'call_3',
      name: 'run_shell_command',
      display: {
        name: 'Shell',
        result: { type: 'text', text: 'primera linea\n' },
      },
      _meta: { legacyState: { status: 'executing' } },
    });

    const progress = events.find((event) => event.type === 'tool_progress');
    expect(progress).toBeDefined();
    if (progress?.type !== 'tool_progress') {
      throw new Error('no tool progress');
    }
    expect(progress.callId).toBe('call_3');
    expect(progress.output).toContain('primera linea');
  });

  it('shortens an error message to something readable', async () => {
    const session = new WebSession(config, settings, '/tmp');
    const events: ServerEvent[] = [];
    session.addClient({ send: (event) => events.push(event) });

    const handler = (
      session as unknown as { handleEvent(event: unknown): void }
    ).handleEvent.bind(session);

    const payload = JSON.stringify({
      error: {
        message: JSON.stringify({ error: { message: 'API key not valid.' } }),
      },
    });
    handler({ type: 'error', message: payload });

    const error = events.find((event) => event.type === 'error');
    expect(error).toBeDefined();
    if (error?.type !== 'error') {
      throw new Error('no error');
    }
    expect(error.message).toBe('API key not valid.');
  });

  it('turns an image attachment into inline media and a file into a reference', () => {
    const session = new WebSession(config, settings, '/tmp');
    const build = (
      session as unknown as {
        buildContent(text: string, attachments: WebAttachment[]): ContentPart[];
      }
    ).buildContent.bind(session);

    const content = build('mira esto', [
      {
        name: 'captura.png',
        mimeType: 'image/png',
        size: 10,
        data: 'aW1hZ2U=',
      },
      {
        name: 'notas.txt',
        mimeType: 'text/plain',
        size: 20,
        path: '/tmp/notas.txt',
      },
    ]);

    expect(content[0]).toEqual({ type: 'text', text: 'mira esto' });
    expect(content[1]).toEqual({
      type: 'media',
      data: 'aW1hZ2U=',
      mimeType: 'image/png',
    });
    expect(content[2]).toEqual({
      type: 'reference',
      text: 'Attached file: notas.txt (/tmp/notas.txt)',
      uri: '/tmp/notas.txt',
    });
  });
});
