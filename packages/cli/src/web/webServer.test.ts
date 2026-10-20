/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebServer } from './webServer.js';
import type { Config } from '@google/gemini-cli-core';
import type { LoadedSettings } from '../config/settings.js';
import type { WebAttachment } from './protocol.js';

/**
 * A configuration that answers every question.
 *
 * The command loaders ask the configuration about many things, and the
 * ones they ask for change as the CLI grows. Anything that is not set
 * here answers with nothing, which is what the loaders expect of a
 * feature that is turned off.
 */
const config = new Proxy(
  {
    getSessionId: () => 'test-session',
    getModel: () => 'test-model',
    getApprovalMode: () => 'default',
    getToolRegistry: () => ({ getAllTools: () => [] }),
    getModelConfigService: () => undefined,
    getGitService: async () => undefined,
    getGeminiClient: () => ({}),
    getFolderTrust: () => ({ isTrusted: () => true }),
    isTrustedFolder: () => true,
    getProjectRoot: () => '/tmp',
    getMcpClientManager: () => ({ getMcpServers: () => ({}) }),
    getContentGeneratorConfig: () => ({ authType: 'LOGIN_WITH_GOOGLE' }),
    getEnableExtensionReloading: () => false,
    getEnableHooksUI: () => false,
    getExtensionsEnabled: () => false,
    getMcpEnabled: () => false,
    getSkillManager: () => ({ getSkill: () => undefined }),
    isAgentsEnabled: () => false,
    isPlanEnabled: () => false,
    isSkillsSupportEnabled: () => false,
    isTodoEnabled: () => false,
    isVoiceModeEnabled: () => false,
    storage: undefined,
  } as unknown as Config,
  {
    get(target: Config, property: string | symbol): unknown {
      if (typeof property === 'symbol') {
        return undefined;
      }
      if (property in target) {
        return (target as unknown as Record<string, unknown>)[property];
      }
      return () => undefined;
    },
  },
);

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
    const commands = (await commandsResponse.json()) as Array<{
      name: string;
    }>;
    expect(Array.isArray(commands)).toBe(true);
    // The built-in commands are there, not an empty list.
    expect(commands.map((command) => command.name)).toContain('help');
  });

  it('stores an uploaded file and returns its path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-upload-'));
    server = new WebServer({ config, settings, cwd: dir, port: 0 });
    const url = await server.start();

    const response = await fetch(
      `${url}/api/upload?name=${encodeURIComponent('notas.txt')}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'contenido',
      },
    );
    expect(response.status).toBe(200);

    const attachment = (await response.json()) as WebAttachment;
    expect(attachment.name).toBe('notas.txt');
    expect(attachment.size).toBe('contenido'.length);
    expect(attachment.path).toBeDefined();
    expect(readFileSync(attachment.path as string, 'utf-8')).toBe('contenido');
  });

  it('keeps an uploaded file inside the upload directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-upload-'));
    server = new WebServer({ config, settings, cwd: dir, port: 0 });
    const url = await server.start();

    const response = await fetch(
      `${url}/api/upload?name=${encodeURIComponent('../../escaped.txt')}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'x',
      },
    );
    expect(response.status).toBe(200);

    const attachment = (await response.json()) as WebAttachment;
    expect(attachment.path?.startsWith(dir)).toBe(true);
    expect(attachment.path).not.toContain('..');
  });
});
