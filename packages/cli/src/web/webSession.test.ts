/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { WebSession } from './webSession.js';
import type { Config } from '@google/gemini-cli-core';
import type { LoadedSettings } from '../config/settings.js';
import type { ServerEvent } from './protocol.js';

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
});
