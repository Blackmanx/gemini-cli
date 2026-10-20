/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSession, type WebAgent } from './webSession.js';
import type { AgentEvent, Config, ContentPart } from '@google/gemini-cli-core';
import type { LoadedSettings } from '../config/settings.js';
import type { ServerEvent, WebAttachment } from './protocol.js';

const config = {
  getSessionId: () => 'test-session',
  getGeminiClient: () => ({ isInitialized: () => true }),
} as unknown as Config;

const settings = {} as LoadedSettings;

/**
 * An agent that does what the test tells it to.
 *
 * The real agent needs a model behind it, and a turn that hangs is
 * exactly what these tests are about, so the agent is replaced by one
 * that can be started, watched and left hanging on purpose.
 */
class FakeAgent implements WebAgent {
  aborted = false;
  sent = 0;
  /** When set, `send` fails with this error. */
  failWith: Error | undefined;
  private listeners: Array<(event: AgentEvent) => void> = [];

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((one) => one !== listener);
    };
  }

  async send(_request: {
    message: { content: ContentPart[] };
  }): Promise<unknown> {
    this.sent++;
    if (this.failWith) {
      throw this.failWith;
    }
    return { streamId: 'test-stream' };
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

/** Waits for the microtasks and timers a turn needs to get going. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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

  it('offers, at the end, the document the answer talks about', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-files-'));
    const working = join(dir, 'test-grid-w.docx');
    const final = join(dir, 'informe.pdf');
    writeFileSync(working, 'draft');
    writeFileSync(final, 'pdf');
    const session = new WebSession(config, settings, dir);
    const events: ServerEvent[] = [];
    session.addClient({ send: (event) => events.push(event) });

    const collect = (
      session as unknown as { collectDocuments(texts: string[]): void }
    ).collectDocuments.bind(session);
    const handleEvent = (
      session as unknown as { handleEvent(event: unknown): void }
    ).handleEvent.bind(session);

    collect([`borrador en ${working}`]);
    collect([`documento en ${final}`]);

    // Nothing is shown while the turn is still running.
    expect(
      events.filter((event) => event.type === 'file_created'),
    ).toHaveLength(0);

    (session as unknown as { messageBuffer: string }).messageBuffer =
      `Listo. El documento está en ${final}`;
    handleEvent({ type: 'agent_end' });

    const created = events.filter((event) => event.type === 'file_created');
    expect(created).toHaveLength(1);
    if (created[0]?.type !== 'file_created') {
      throw new Error('no file was announced');
    }
    expect(created[0].file.path).toBe(final);
    expect(created[0].file.kind).toBe('pdf');
    expect(created[0].file.name).toBe('informe.pdf');
    expect(created[0].file.previewable).toBe(true);
  });

  it('shows the newest document when the answer names none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-files-'));
    const older = join(dir, 'plantilla.docx');
    const newer = join(dir, 'cuentas.xlsx');
    writeFileSync(older, 'a');
    writeFileSync(newer, 'b');
    const past = new Date(Date.now() - 60_000);
    utimesSync(older, past, past);

    const session = new WebSession(config, settings, dir);
    const events: ServerEvent[] = [];
    session.addClient({ send: (event) => events.push(event) });
    const collect = (
      session as unknown as { collectDocuments(texts: string[]): void }
    ).collectDocuments.bind(session);
    const handleEvent = (
      session as unknown as { handleEvent(event: unknown): void }
    ).handleEvent.bind(session);

    collect([older, newer]);
    handleEvent({ type: 'agent_end' });

    const created = events.filter((event) => event.type === 'file_created');
    expect(created).toHaveLength(1);
    if (created[0]?.type !== 'file_created') {
      throw new Error('no file was announced');
    }
    expect(created[0].file.path).toBe(newer);
  });

  it('announces the same document only once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-files-'));
    const document = join(dir, 'cuentas.xlsx');
    writeFileSync(document, 'cells');
    const session = new WebSession(config, settings, dir);
    const events: ServerEvent[] = [];
    session.addClient({ send: (event) => events.push(event) });
    const collect = (
      session as unknown as { collectDocuments(texts: string[]): void }
    ).collectDocuments.bind(session);
    const handleEvent = (
      session as unknown as { handleEvent(event: unknown): void }
    ).handleEvent.bind(session);

    collect([document]);
    handleEvent({ type: 'agent_end' });
    collect([document]);
    handleEvent({ type: 'agent_end' });

    expect(
      events.filter((event) => event.type === 'file_created'),
    ).toHaveLength(1);
  });

  it('names a folder as a folder when it is attached', () => {
    const session = new WebSession(config, settings, '/tmp');
    const build = (
      session as unknown as {
        buildContent(text: string, attachments: WebAttachment[]): ContentPart[];
      }
    ).buildContent.bind(session);

    const content = build('revisa esto', [
      {
        name: 'informes',
        mimeType: 'inode/directory',
        size: 100,
        path: '/tmp/.gemini-web-uploads/informes',
        kind: 'folder',
        fileCount: 3,
      },
    ]);

    expect(content[1]).toEqual({
      type: 'reference',
      text: 'Attached folder: informes (/tmp/.gemini-web-uploads/informes)',
      uri: '/tmp/.gemini-web-uploads/informes',
    });
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

describe('WebSession turns', () => {
  it('ends the turn when the agent says it is done', async () => {
    const agent = new FakeAgent();
    const session = new WebSession(config, settings, '/tmp', () => agent);
    const events: ServerEvent[] = [];
    session.addClient({ send: (event) => events.push(event) });

    const turn = session.send('hola');
    await settle();
    agent.emit({ type: 'agent_end' } as AgentEvent);
    await turn;

    expect(events.some((event) => event.type === 'turn_started')).toBe(true);
    const ended = events.find((event) => event.type === 'turn_ended');
    expect(ended).toBeDefined();
    expect(ended?.type === 'turn_ended' && ended.cancelled).toBe(false);
  });

  it('ends the turn when the agent fails', async () => {
    const agent = new FakeAgent();
    agent.failWith = new Error('the model is on fire');
    const session = new WebSession(config, settings, '/tmp', () => agent);
    const events: ServerEvent[] = [];
    session.addClient({ send: (event) => events.push(event) });

    await session.send('hola');

    const error = events.find((event) => event.type === 'error');
    expect(error?.type === 'error' && error.message).toBe(
      'the model is on fire',
    );
    expect(events.some((event) => event.type === 'turn_ended')).toBe(true);
  });

  it('refuses a second prompt while a turn is running', async () => {
    const agent = new FakeAgent();
    const session = new WebSession(config, settings, '/tmp', () => agent);
    const events: ServerEvent[] = [];
    session.addClient({ send: (event) => events.push(event) });

    const first = session.send('primero');
    await settle();
    await session.send('segundo');

    expect(agent.sent).toBe(1);
    const error = events.find((event) => event.type === 'error');
    expect(error?.type === 'error' && error.message).toContain(
      'already running',
    );
    expect(events.filter((event) => event.type === 'turn_started').length).toBe(
      1,
    );

    agent.emit({ type: 'agent_end' } as AgentEvent);
    await first;
  });

  it('releases the turn when it is cancelled', async () => {
    const agent = new FakeAgent();
    const session = new WebSession(config, settings, '/tmp', () => agent);
    const events: ServerEvent[] = [];
    session.addClient({ send: (event) => events.push(event) });

    const turn = session.send('hola');
    await settle();
    await session.cancel();
    await turn;

    expect(agent.aborted).toBe(true);
    const ended = events.find((event) => event.type === 'turn_ended');
    expect(ended?.type === 'turn_ended' && ended.cancelled).toBe(true);
  });

  it('stops the turn when the last listener leaves', async () => {
    const agent = new FakeAgent();
    const session = new WebSession(config, settings, '/tmp', () => agent);
    const events: ServerEvent[] = [];
    const first = { send: (event: ServerEvent) => events.push(event) };
    const second = { send: (event: ServerEvent) => events.push(event) };
    session.addClient(first);
    session.addClient(second);

    const turn = session.send('hola');
    await settle();

    session.removeClient(first);
    await settle();
    // There is still someone watching, so the turn carries on.
    expect(agent.aborted).toBe(false);

    session.removeClient(second);
    await turn;
    // Nobody is left to answer a confirmation, so the turn is stopped.
    expect(agent.aborted).toBe(true);
  });

  it('releases the turn when the session is disposed', async () => {
    const agent = new FakeAgent();
    const session = new WebSession(config, settings, '/tmp', () => agent);
    session.addClient({ send: () => {} });

    const turn = session.send('hola');
    await settle();
    await session.dispose();
    // The turn resolves rather than waiting for an agent that is gone.
    await turn;

    expect(agent.aborted).toBe(true);
  });

  it('stops a turn that goes quiet for too long', async () => {
    vi.useFakeTimers();
    try {
      const agent = new FakeAgent();
      const session = new WebSession(config, settings, '/tmp', () => agent);
      const events: ServerEvent[] = [];
      session.addClient({ send: (event) => events.push(event) });

      const turn = session.send('hola');
      await vi.advanceTimersByTimeAsync(0);

      // Ten minutes of nothing.
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      await turn;

      expect(agent.aborted).toBe(true);
      const error = events.find((event) => event.type === 'error');
      expect(error?.type === 'error' && error.message).toContain(
        'stopped responding',
      );
      expect(events.some((event) => event.type === 'turn_ended')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a turn alive while the agent is still talking', async () => {
    vi.useFakeTimers();
    try {
      const agent = new FakeAgent();
      const session = new WebSession(config, settings, '/tmp', () => agent);
      const events: ServerEvent[] = [];
      session.addClient({ send: (event) => events.push(event) });

      const turn = session.send('hola');
      await vi.advanceTimersByTimeAsync(0);

      // The agent keeps sending things, so the silence timer keeps moving.
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        agent.emit({
          type: 'message',
          role: 'model',
          content: [{ type: 'text', text: `paso ${i}` }],
        } as unknown as AgentEvent);
      }

      expect(agent.aborted).toBe(false);
      expect(events.some((event) => event.type === 'error')).toBe(false);

      agent.emit({ type: 'agent_end' } as AgentEvent);
      await turn;
    } finally {
      vi.useRealTimers();
    }
  });
});
