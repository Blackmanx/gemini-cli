/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebServer } from './webServer.js';
import { WebSocket } from 'ws';
import type { Config } from '@google/gemini-cli-core';
import type { LoadedSettings } from '../config/settings.js';
import type { ServerEvent, WebAttachment } from './protocol.js';

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

/** Opens a socket to the server and collects what it sends. */
async function connect(url: string): Promise<{
  events: ServerEvent[];
  send: (request: unknown) => void;
  waitFor: (match: (event: ServerEvent) => boolean) => Promise<ServerEvent>;
  close: () => void;
}> {
  const events: ServerEvent[] = [];
  const socket = new WebSocket(`ws://${url.replace('http://', '')}/ws`);
  socket.on('message', (data) => {
    events.push(JSON.parse(data.toString()) as ServerEvent);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const waitFor = async (
    match: (event: ServerEvent) => boolean,
  ): Promise<ServerEvent> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = events.find(match);
      if (found) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('the server did not send the expected event');
  };
  return {
    events,
    send: (request) => socket.send(JSON.stringify(request)),
    waitFor,
    close: () => socket.close(),
  };
}

describe('WebServer tool confirmations', () => {
  let server: WebServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  /** A server whose message bus and policy engine the test controls. */
  function serverWith(options: {
    decision?: string;
    published: unknown[];
    requests: Array<(request: unknown) => void>;
  }): WebServer {
    const bus = {
      subscribe: (
        _type: string,
        listener: (request: unknown) => void,
      ): (() => void) => {
        options.requests.push(listener);
        return () => {};
      },
      publish: async (message: unknown): Promise<void> => {
        options.published.push(message);
      },
    };
    const configured = new Proxy(config, {
      get(target, property: string | symbol): unknown {
        if (property === 'getMessageBus') {
          return () => bus;
        }
        if (property === 'getPolicyEngine') {
          return () => ({
            check: async () => ({ decision: options.decision ?? 'ask_user' }),
          });
        }
        return Reflect.get(target, property) as unknown;
      },
    });
    return new WebServer({
      config: configured,
      settings,
      cwd: '/tmp',
      port: 0,
    });
  }

  const toolUpdate = {
    toolCalls: [
      {
        status: 'awaiting_approval',
        correlationId: 'corr-1',
        confirmationDetails: {
          type: 'exec',
          title: 'Run shell command',
          command: 'ls -F /tmp',
          rootCommand: 'ls',
          rootCommands: ['ls'],
        },
        request: {
          callId: 'call-1',
          name: 'run_shell_command',
          args: { command: 'ls -F /tmp' },
        },
      },
    ],
  };

  it('asks the browser before a tool runs and passes the answer on', async () => {
    const published: unknown[] = [];
    const requests: Array<(request: unknown) => void> = [];
    server = serverWith({ published, requests });
    const url = await server.start();
    const client = await connect(url);

    try {
      expect(requests).toHaveLength(1);
      requests[0](toolUpdate);

      const asked = await client.waitFor(
        (event) => event.type === 'confirmation_request',
      );
      if (asked.type !== 'confirmation_request') {
        throw new Error('not a confirmation request');
      }
      expect(asked.request.details).toBe('ls -F /tmp');
      expect(asked.request.title).toBe('Run shell command');
      expect(asked.request.callId).toBe('call-1');

      client.send({
        type: 'confirmation_response',
        id: asked.request.id,
        confirmed: true,
      });

      const deadline = Date.now() + 10_000;
      while (published.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        type: 'tool-confirmation-response',
        correlationId: 'corr-1',
        confirmed: true,
      });
    } finally {
      client.close();
    }
  });

  it('asks about a waiting tool only once, however many updates arrive', async () => {
    const published: unknown[] = [];
    const requests: Array<(request: unknown) => void> = [];
    server = serverWith({ published, requests });
    const url = await server.start();
    const client = await connect(url);

    try {
      requests[0](toolUpdate);
      requests[0](toolUpdate);
      requests[0](toolUpdate);

      await client.waitFor((event) => event.type === 'confirmation_request');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(
        client.events.filter((event) => event.type === 'confirmation_request'),
      ).toHaveLength(1);
    } finally {
      client.close();
    }
  });

  it('changes the approval mode when the browser asks', async () => {
    const setMode = vi.fn();
    const configured = new Proxy(config, {
      get(target, property: string | symbol): unknown {
        if (property === 'setApprovalMode') {
          return setMode;
        }
        return Reflect.get(target, property) as unknown;
      },
    });
    server = new WebServer({
      config: configured,
      settings,
      cwd: '/tmp',
      port: 0,
    });
    const url = await server.start();
    const client = await connect(url);

    try {
      client.send({ type: 'set_approval_mode', mode: 'yolo' });
      await client.waitFor((event) => event.type === 'approval_mode');
      expect(setMode).toHaveBeenCalledWith('yolo');
    } finally {
      client.close();
    }
  });
});
