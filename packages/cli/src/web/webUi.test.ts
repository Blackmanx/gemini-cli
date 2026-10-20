/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { WebServer } from './webServer.js';
import { WebConfirmationBroker, createWebUI, promptToText } from './webUi.js';
import type { Config } from '@google/gemini-cli-core';
import { WebSocket } from 'ws';
import type { LoadedSettings } from '../config/settings.js';
import type { ServerEvent } from './protocol.js';

describe('webUi', () => {
  it('flattens a confirmation prompt into text', () => {
    expect(promptToText('Are you sure?')).toBe('Are you sure?');
    expect(promptToText(['a', 'b'])).toBe('a\nb');
    expect(promptToText(null)).toBe('');
  });

  it('resolves a confirmation once the browser answers', async () => {
    const sent: ServerEvent[] = [];
    const broker = new WebConfirmationBroker((event) => sent.push(event));

    const pending = broker.request('Confirm', 'Run the command?');
    const request = sent.find((event) => event.type === 'confirmation_request');
    expect(request).toBeDefined();
    if (request?.type !== 'confirmation_request') {
      throw new Error('no confirmation request was sent');
    }
    expect(request.request.details).toBe('Run the command?');

    expect(broker.resolve(request.request.id, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
  });

  it('forwards history items to the browser', () => {
    const sent: ServerEvent[] = [];
    const broker = new WebConfirmationBroker((event) => sent.push(event));
    const ui = createWebUI((event) => sent.push(event), broker);

    ui.addItem({ type: 'info', text: 'hello' } as never, Date.now());

    expect(sent.some((event) => event.type === 'history_item')).toBe(true);
  });
});

describe('WebServer over a socket', () => {
  it('accepts a connection and announces the session', async () => {
    const config = {
      getSessionId: () => 'test-session',
      getModel: () => 'test-model',
      getApprovalMode: () => 'default',
      getToolRegistry: () => ({ getAllTools: () => [] }),
      getModelConfigService: () => undefined,
      getGitService: async () => undefined,
      getGeminiClient: () => ({}),
    } as unknown as Config;

    const settings = {
      merged: {},
      forScope: () => ({ settings: {} }),
      setValue: () => {},
    } as unknown as LoadedSettings;

    const server = new WebServer({ config, settings, cwd: '/tmp', port: 0 });
    const url = await server.start();

    try {
      const events: ServerEvent[] = [];

      // The server sends `session_started` as soon as the socket opens, so
      // the listener has to be attached before the handshake completes.
      const received: Promise<ServerEvent> = new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://${url.replace('http://', '')}/ws`);
        socket.on('message', (data) => {
          resolve(JSON.parse(data.toString()) as ServerEvent);
        });
        socket.on('error', reject);
        setTimeout(
          () => reject(new Error('timed out waiting for the session')),
          10_000,
        );
      });

      const first = await received;
      events.push(first);

      const started = events.find((event) => event.type === 'session_started');
      expect(started).toBeDefined();
      expect(started?.type === 'session_started' && started.sessionId).toBe(
        'test-session',
      );
    } finally {
      await server.stop();
    }
  });
});
