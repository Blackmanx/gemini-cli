/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { debugLogger } from '@google/gemini-cli-core';
import { isWsl } from './clipboardUtils.js';

/**
 * A warm, long-lived `powershell.exe` process that answers Windows clipboard
 * image queries from WSL.
 *
 * Every one-shot `powershell.exe` spawn costs ~1s of WSL interop + .NET
 * startup plus ~0.4s of `Add-Type` assembly loading, which made an image
 * paste (probe + save = two spawns) take multiple seconds. Keeping one
 * process alive moves that cost to a single background warm-up; subsequent
 * round-trips are pipe writes measured in milliseconds.
 *
 * The script is passed inline via `-Command` (like the one-shot save path):
 * script *files* are blocked by the default Windows execution policy, and
 * inline commands are not.
 *
 * Protocol (one command line in, one response line out):
 *   (on start)  READY                      - assemblies loaded, loop running
 *   HAS_IMAGE   -> IMG:YES | IMG:NO
 *   GET_IMAGE   -> B64:<png base64> | NO_IMAGE | ERROR:<message>
 *   EXIT        -> process exits
 *
 * Stdin EOF also exits the loop, so the process disappears on its own if
 * the CLI dies without an orderly shutdown.
 */

const READY_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const STOP_GRACE_MS = 500;

const BRIDGE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq 'EXIT') { break }
  try {
    if ($line -eq 'HAS_IMAGE') {
      if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
        [Console]::Out.WriteLine('IMG:YES')
      } else {
        [Console]::Out.WriteLine('IMG:NO')
      }
    } elseif ($line -eq 'GET_IMAGE') {
      if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
        $image = [System.Windows.Forms.Clipboard]::GetImage()
        $stream = New-Object System.IO.MemoryStream
        $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        [Console]::Out.WriteLine('B64:' + [Convert]::ToBase64String($stream.ToArray()))
        $stream.Dispose()
        $image.Dispose()
      } else {
        [Console]::Out.WriteLine('NO_IMAGE')
      }
    } else {
      [Console]::Out.WriteLine('ERROR:unknown command')
    }
  } catch {
    [Console]::Out.WriteLine('ERROR:' + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
`;

interface LineWaiter {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  predicate: ((line: string) => boolean) | undefined;
  timer: NodeJS.Timeout;
}

export class WslClipboardBridge {
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private stdoutBuffer = '';
  private lineWaiters: LineWaiter[] = [];
  private requestQueue: Promise<unknown> = Promise.resolve();

  /** True while a live child process exists. */
  get running(): boolean {
    return this.child !== null && !this.child.killed;
  }

  /**
   * Starts the bridge process and waits until it reports READY.
   * Idempotent: concurrent/repeat calls share one start attempt.
   */
  start(): Promise<void> {
    if (this.startPromise !== null) {
      return this.startPromise;
    }
    this.startPromise = new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-STA',
            '-Command',
            BRIDGE_SCRIPT,
          ],
          { stdio: ['pipe', 'pipe', 'ignore'] },
        );
      } catch (e) {
        this.startPromise = null;
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      this.child = child;
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.reset();
        reject(error);
      };

      const readyTimer = setTimeout(() => {
        fail(
          new Error(`clipboard bridge not ready within ${READY_TIMEOUT_MS}ms`),
        );
        // reset() already detached this.child; kill the local reference.
        try {
          child.kill('SIGKILL');
        } catch {
          // Already dead.
        }
      }, READY_TIMEOUT_MS);
      readyTimer.unref?.();

      child.once('error', (error) => {
        clearTimeout(readyTimer);
        fail(error);
      });

      child.once('exit', (code) => {
        clearTimeout(readyTimer);
        fail(new Error(`clipboard bridge exited early (code ${code})`));
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        this.handleStdout(chunk.toString());
      });

      void this.nextLine(READY_TIMEOUT_MS, (line) => line === 'READY')
        .then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(readyTimer);
          // The 'exit' listener registered above keeps failing the (already
          // resolved) promise; swap it for the steady-state teardown path.
          child.removeAllListeners('exit');
          child.on('exit', () => {
            this.reset();
          });
          resolve();
        })
        .catch((error: Error) => {
          clearTimeout(readyTimer);
          fail(error);
          this.kill();
        });
    });
    return this.startPromise;
  }

  /** Warm the bridge in the background; never throws. */
  warmUp(): void {
    void this.start().catch((e) => {
      debugLogger.debug('clipboard bridge warm-up failed:', e);
    });
  }

  /** Does the Windows clipboard contain an image? */
  async hasImage(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<boolean> {
    const line = await this.request('HAS_IMAGE', timeoutMs);
    if (line === 'IMG:YES') return true;
    if (line === 'IMG:NO') return false;
    throw new Error(`unexpected clipboard bridge response: ${line}`);
  }

  /**
   * The clipboard image as PNG bytes.
   * Returns null when the clipboard definitively holds no image; throws when
   * the bridge cannot answer (caller falls back to a one-shot spawn).
   */
  async getImagePng(
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Buffer | null> {
    const line = await this.request('GET_IMAGE', timeoutMs);
    if (line === 'NO_IMAGE') return null;
    if (line.startsWith('B64:')) {
      const buffer = Buffer.from(line.slice(4), 'base64');
      if (buffer.length === 0) {
        return null;
      }
      return buffer;
    }
    throw new Error(`clipboard bridge could not read image: ${line}`);
  }

  /** Sends a command and returns the response line. Serialized per bridge. */
  async request(command: string, timeoutMs: number): Promise<string> {
    const run = this.requestQueue.then(() => this.rawRequest(command, timeoutMs));
    // Keep the queue alive even when a request fails.
    this.requestQueue = run.catch(() => {});
    return run;
  }

  /** Stops the bridge; the next request starts a fresh process. */
  stop(): void {
    if (this.child !== null) {
      try {
        this.child.stdin?.write('EXIT\n');
      } catch {
        // The pipe may already be gone.
      }
      const child = this.child;
      const graceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already dead.
        }
      }, STOP_GRACE_MS);
      graceTimer.unref?.();
    }
    this.reset();
  }

  private async rawRequest(command: string, timeoutMs: number): Promise<string> {
    await this.start();
    const child = this.child;
    if (child === null || child.stdin === null) {
      throw new Error('clipboard bridge is not running');
    }
    // Register the waiter before writing so a fast response cannot race us.
    const responsePromise = this.nextLine(timeoutMs);
    child.stdin.write(`${command}\n`);
    const line = await responsePromise;
    if (line.startsWith('ERROR:')) {
      throw new Error(`clipboard bridge error: ${line.slice(6)}`);
    }
    return line;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line === '') continue;
      this.deliverLine(line);
    }
  }

  private deliverLine(line: string): void {
    const index = this.lineWaiters.findIndex(
      (waiter) => waiter.predicate === undefined || waiter.predicate(line),
    );
    if (index === -1) {
      // Unsolicited output (e.g. a PowerShell warning): not a response.
      debugLogger.debug(`clipboard bridge ignored output line: ${line.slice(0, 200)}`);
      return;
    }
    const [waiter] = this.lineWaiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(line);
  }

  private nextLine(
    timeoutMs: number,
    predicate?: (line: string) => boolean,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const waiter: LineWaiter = {
        resolve,
        reject,
        predicate,
        timer: setTimeout(() => {
          const index = this.lineWaiters.indexOf(waiter);
          if (index !== -1) {
            this.lineWaiters.splice(index, 1);
          }
          // A stalled bridge is unusable: tear it down so the next attempt
          // gets a fresh process.
          this.kill();
          reject(new Error(`clipboard bridge timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.lineWaiters.push(waiter);
    });
  }

  private kill(): void {
    if (this.child !== null) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // Already dead.
      }
    }
    this.reset();
  }

  /** Clears all state after the child is gone. */
  private reset(): void {
    this.child = null;
    this.startPromise = null;
    this.stdoutBuffer = '';
    const waiters = this.lineWaiters;
    this.lineWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('clipboard bridge stopped'));
    }
  }
}

let singleton: WslClipboardBridge | null = null;
let exitHookInstalled = false;

/** The process-wide bridge instance (created lazily). */
export function getWslClipboardBridge(): WslClipboardBridge {
  if (singleton === null) {
    singleton = new WslClipboardBridge();
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.once('exit', () => {
        try {
          singleton?.stop();
        } catch {
          // Best effort on the way out.
        }
      });
    }
  }
  return singleton;
}

/**
 * Starts the bridge in the background so the first paste is already warm.
 * No-op outside WSL. Never throws.
 */
export function warmUpClipboardBridge(): void {
  if (!isWsl()) {
    return;
  }
  getWslClipboardBridge().warmUp();
}

/** Stops the bridge (used on shutdown and in tests). */
export function stopClipboardBridge(): void {
  singleton?.stop();
  singleton = null;
}
