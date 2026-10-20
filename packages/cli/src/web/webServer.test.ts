/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { WebServer } from './webServer.js';
import type { Config } from '@google/gemini-cli-core';
import type { LoadedSettings } from '../config/settings.js';

const config = {
  getSessionId: () => 'test-session',
  getModel: () => 'test-model',
  getApprovalMode: () => 'default',
  getToolRegistry: () => ({ getAllTools: () => [] }),
  getModelConfigService: () => undefined,
  getGitService: async () => undefined,
  getGeminiClient: () => ({}),
  storage: undefined,
} as unknown as Config;

const settings = {
  merged: {},
  forScope: () => ({ settings: {} }),
  setValue: () => {},
} as unknown as LoadedSettings;

describe('WebServer', () => {
  let server: WebServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('serves the client and rejects cross-origin requests', async () => {
    server = new WebServer({ config, settings, cwd: '/tmp', port: 0 });
    const url = await server.start();

    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<div id="root">');

    const script = await fetch(`${url}/assets/main.js`);
    expect(script.status).toBe(200);
    expect(await script.text()).toContain('createRoot');

    const crossOrigin = await fetch(`${url}/`, {
      headers: { Origin: 'http://evil.example' },
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('exposes the settings and commands as JSON', async () => {
    server = new WebServer({ config, settings, cwd: '/tmp', port: 0 });
    const url = await server.start();

    const settingsResponse = await fetch(`${url}/api/settings`);
    expect(settingsResponse.status).toBe(200);
    expect(Array.isArray(await settingsResponse.json())).toBe(true);

    const commandsResponse = await fetch(`${url}/api/commands`);
    expect(commandsResponse.status).toBe(200);
    expect(Array.isArray(await commandsResponse.json())).toBe(true);
  });
});
