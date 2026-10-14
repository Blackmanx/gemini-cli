/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
vi.mock('@google/gemini-cli-core', () => ({
  debugLogger: { debug: vi.fn(), warn: vi.fn() },
}));

import { WslClipboardBridge } from './wslClipboardBridge.js';

/** Minimal stand-in for the spawned powershell.exe child process. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

/**
 * Answers bridge commands as the PowerShell loop would.
 * Register before issuing requests.
 */
function respondToCommands(child: FakeChild): void {
  child.stdin.on('data', (data: Buffer) => {
    const command = data.toString().trim();
    switch (command) {
      case 'HAS_IMAGE':
        child.stdout.write('IMG:YES\r\n');
        break;
      case 'GET_IMAGE':
        child.stdout.write(
          `B64:${Buffer.from('png-bytes').toString('base64')}\r\n`,
        );
        break;
      case 'GET_IMAGE_EMPTY':
        child.stdout.write('NO_IMAGE\r\n');
        break;
      case 'GET_IMAGE_ERROR':
        child.stdout.write('ERROR:clipboard locked\r\n');
        break;
      case 'EXIT':
        child.emit('exit', 0);
        break;
      default:
        break;
    }
  });
}

describe('WslClipboardBridge', () => {
  let child: FakeChild;
  let bridge: WslClipboardBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    child = new FakeChild();
    mockSpawn.mockReturnValue(child);
    bridge = new WslClipboardBridge();
  });

  afterEach(() => {
    bridge.stop();
    vi.useRealTimers();
  });

  async function startBridge(): Promise<void> {
    const startPromise = bridge.start();
    child.stdout.write('READY\r\n');
    await startPromise;
  }

  it('spawns powershell.exe with -File and resolves when READY arrives', async () => {
    const startPromise = bridge.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-Command',
        expect.stringContaining('READY'),
      ]),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'ignore'] }),
    );
    expect(bridge.running).toBe(true);

    child.stdout.write('READY\r\n');
    await expect(startPromise).resolves.toBeUndefined();
  });

  it('rejects start when the process exits before READY', async () => {
    const startPromise = bridge.start();
    child.emit('exit', 1);

    await expect(startPromise).rejects.toThrow(/exited early/);
    expect(bridge.running).toBe(false);
  });

  it('rejects start when the bridge never becomes ready', async () => {
    vi.useFakeTimers();
    const startPromise = bridge.start();
    // Attach a catch immediately so the rejection that happens while timers
    // advance is never unhandled.
    startPromise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(20000);
    await expect(startPromise).rejects.toThrow(/not ready/);
    expect(child.kill).toHaveBeenCalled();
  });

  it('hasImage reports IMG:YES as true', async () => {
    await startBridge();
    respondToCommands(child);

    await expect(bridge.hasImage()).resolves.toBe(true);
  });

  it('getImagePng decodes the base64 PNG payload', async () => {
    await startBridge();
    respondToCommands(child);

    const png = await bridge.getImagePng();
    expect(png).toEqual(Buffer.from('png-bytes'));
  });

  it('getImagePng returns null when the clipboard has no image', async () => {
    await startBridge();
    child.stdin.on('data', (data: Buffer) => {
      if (data.toString().trim() === 'GET_IMAGE') {
        child.stdout.write('NO_IMAGE\r\n');
      }
    });

    await expect(bridge.getImagePng()).resolves.toBeNull();
  });

  it('throws on an ERROR response so the caller can fall back', async () => {
    await startBridge();
    child.stdin.on('data', (data: Buffer) => {
      if (data.toString().trim() === 'GET_IMAGE') {
        child.stdout.write('ERROR:clipboard locked\r\n');
      }
    });

    await expect(bridge.getImagePng()).rejects.toThrow(/clipboard locked/);
  });

  it('kills the bridge and rejects when a request times out', async () => {
    await startBridge();
    // No responder: the request should time out.

    await expect(bridge.hasImage(50)).rejects.toThrow(/timed out/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(bridge.running).toBe(false);
  });

  it('serializes concurrent requests in order', async () => {
    await startBridge();
    respondToCommands(child);

    const [image, png] = await Promise.all([
      bridge.hasImage(),
      bridge.getImagePng(),
    ]);

    expect(image).toBe(true);
    expect(png).toEqual(Buffer.from('png-bytes'));
  });

  it('stop sends EXIT and clears state', async () => {
    await startBridge();
    const chunks: string[] = [];
    child.stdin.on('data', (data: Buffer) => chunks.push(data.toString()));

    bridge.stop();
    // Stream 'data' events land on a later tick.
    await new Promise((resolve) => setImmediate(resolve));

    expect(chunks.join('')).toContain('EXIT');
    expect(bridge.running).toBe(false);
  });

  it('ignores unsolicited output lines', async () => {
    await startBridge();
    child.stdout.write('WARNING: something\r\n');
    respondToCommands(child);

    await expect(bridge.hasImage()).resolves.toBe(true);
  });
});
