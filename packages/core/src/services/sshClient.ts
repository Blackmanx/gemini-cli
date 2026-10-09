/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig } from 'ssh2';
import type { SshProfile } from './sshProfileService.js';

export interface SshExecOptions {
  /** Seconds to wait for connect and for the command; the agent sets both. */
  timeoutMs: number;
  /** Called with stdout and stderr chunks as they arrive. */
  onData?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  /** The remote command's own exit status; `null` when the channel never ran. */
  exitCode: number | null;
  /** True when the command was still running at the timeout. */
  timedOut: boolean;
  durationMs: number;
}

export class SshError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'connect'
      | 'auth'
      | 'exec'
      | 'no_profile'
      | 'no_sudo_password'
      | 'timeout',
  ) {
    super(message);
    this.name = 'SshError';
  }
}

/** How long to keep an idle connection before dropping it, in ms. */
const KEEPALIVE_INTERVAL_MS = 20_000;

/**
 * A single SSH connection reused across commands.
 *
 * Reuse is what makes an agent session bearable: every command on the same
 * profile shares one TCP and one SSH handshake, and each command still gets a
 * fresh `exec` channel with its own exit code, so one command cannot leak
 * state into the next.
 */
export class SshConnection {
  private client?: Client;
  private connecting?: Promise<void>;

  constructor(private readonly config: ConnectConfig) {}

  static async open(
    profile: SshProfile,
    credentials: { password?: string | null },
  ): Promise<SshConnection> {
    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.user,
      readyTimeout: 15_000,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      ...(profile.identityFile && { privateKey: profile.identityFile }),
      ...(credentials.password && { password: credentials.password }),
    };
    const connection = new SshConnection(config);
    await connection.connect();
    return connection;
  }

  private connect(): Promise<void> {
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = new Promise<void>((resolve, reject) => {
      const client = new Client();
      // A one-shot handshake failure must not poison later attempts, so the
      // cached promise is cleared before the throw propagates.
      const fail = (error: Error) => {
        this.connecting = undefined;
        client.end();
        reject(error);
      };

      client
        .on('ready', () => {
          this.client = client;
          resolve();
        })
        .on('error', (error: Error & { level?: string }) => {
          const reason =
            error.level === 'client-authentication' ? 'auth' : 'connect';
          fail(new SshError(describeConnectError(error, reason), reason));
        });
      client.connect(this.config);
    });

    return this.connecting;
  }

  /** Runs `command` on the remote host and resolves with its result. */
  async exec(command: string, options: SshExecOptions): Promise<SshExecResult> {
    const client = this.client;
    if (!client) {
      throw new SshError('SSH connection is not open.', 'connect');
    }

    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let timedOut = false;
    let settled = false;
    let channel: ClientChannel | undefined;

    return new Promise<SshExecResult>((resolve, reject) => {
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({
          stdout,
          stderr,
          exitCode,
          timedOut,
          durationMs: Date.now() - started,
        });
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(error);
      };

      // Both the abort and the timeout close the channel rather than the
      // connection: one command ending must not cost the session its
      // authenticated SSH transport and every later command a handshake.
      const onAbort = () => {
        channel?.close();
        finish();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        channel?.close();
        finish();
      }, options.timeoutMs);

      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort);

      // `exec` is asynchronous even though it returns the client: the channel
      // is only handed back once the server has answered the exec request.
      client.exec(
        command,
        (error: Error | undefined, opened: ClientChannel) => {
          if (settled) {
            opened.close();
            return;
          }
          if (error) {
            fail(new SshError(error.message, 'exec'));
            return;
          }

          channel = opened;
          opened.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            stdout += text;
            options.onData?.(text);
          });

          opened.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            stderr += text;
            options.onData?.(text);
          });

          // Bound to the channel itself, not to the end of the previous chain:
          // `opened.stderr.on(...)` returns the stderr stream, so chaining from
          // there would subscribe exit/close to stderr, which never reports a
          // command's status. `close` also carries only the close signature;
          // the command's own status arrives separately on `exit`.
          opened.on('exit', (code: number | null) => {
            exitCode = code;
          });
          opened.on('close', () => {
            finish();
          });
          opened.on('error', (err: Error) => {
            fail(new SshError(err.message, 'exec'));
          });
        },
      );
    });
  }

  close(): void {
    this.connecting = undefined;
    this.client?.end();
    this.client = undefined;
  }
}

/**
 * Keeps one live connection per profile for the length of a session.
 *
 * The agent runs many commands against the same host; without this, each call
 * would pay a full TCP and SSH handshake. A failed open is not cached, so a
 * host that was down at the start of the session becomes reachable once it
 * comes back.
 */
export class SshConnectionPool {
  private readonly connections = new Map<string, Promise<SshConnection>>();

  constructor(private readonly credentials: SshProfileCredentials) {}

  async get(profile: SshProfile): Promise<SshConnection> {
    const existing = this.connections.get(profile.name);
    if (existing) {
      return existing;
    }

    const password = await this.credentials.getPassword(profile.name);
    const pending = SshConnection.open(profile, { password });
    this.connections.set(profile.name, pending);
    try {
      return await pending;
    } catch (error) {
      this.connections.delete(profile.name);
      throw error;
    }
  }

  /** Closes and forgets one profile's connection. */
  async close(profileName: string): Promise<void> {
    const pending = this.connections.get(profileName);
    this.connections.delete(profileName);
    if (!pending) {
      return;
    }
    (await pending.catch(() => undefined))?.close();
  }

  async closeAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map((name) => this.close(name)));
  }
}

/** The keychain lookups a connection needs, kept behind an interface. */
export interface SshProfileCredentials {
  getPassword(name: string): Promise<string | null>;
  getSudoPassword(name: string): Promise<string | null>;
}

function describeConnectError(
  error: Error & { level?: string },
  reason: 'connect' | 'auth',
): string {
  return reason === 'auth'
    ? `SSH authentication failed: ${error.message}`
    : `Cannot reach SSH host: ${error.message}`;
}

/**
 * Wraps a command in `sudo -S`, feeding the stored password on stdin.
 *
 * `-S` reads the password from stdin rather than the terminal, which is the
 * only way to make sudo work over a non-interactive `exec` channel. `-p ''`
 * suppresses the lecture prompt so it cannot leak into stdout, and `sh -c`
 * keeps the original command exactly one argument, so the agent's quoting is
 * the remote shell's problem and never ours.
 */
export function buildSudoCommand(
  command: string,
  sudoPassword: string,
): string {
  return `printf '%s\\n' ${shellQuote(sudoPassword)} | sudo -S -p '' -- sh -c ${shellQuote(command)}`;
}

/** POSIX single-quoting: the only escaping that is correct for every byte. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Matches commands that need a human yes/no before they run.
 *
 * This is a floor, not a defence: it catches the shapes that destroy a host by
 * accident (`rm -rf`, `DROP TABLE`, `reboot`) so the operator gets asked, while
 * the PolicyEngine remains the layer that can deny or allow by rule.
 */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\b/i,
  /\brm\s+--recursive\b/i,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /\bdd\b[^|;]*\bof=/i,
  /\bshred\b/i,
  /\bsystemctl\s+(stop|restart|reload|disable|mask)\b/i,
  /\bservice\s+\S+\s+(stop|restart|reload)\b/i,
  /\breboot\b|\bshutdown\b|\bhalt\b|\bpoweroff\b/i,
  /\bkillall\b|\bpkill\b/i,
  /\bchown\s+-R\b|\bchmod\s+-R\b/i,
  /\b(iptables|ufw)\b[^|;]*\b(flush|reset|disable)\b/i,
  /\btruncate\b[^|;]*\bs-[0-9]/i,
  /\bdrop\s+(database|table|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\bupdate\s+\S+\s+set\b/i,
  /\bdrop\s+(user|role)\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|clean\s+--force|push\s+--force)\b/i,
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+(rm|prune)|compose\s+down)\b/i,
  /\bkubectl\s+delete\b/i,
  /\bhelm\s+(delete|uninstall)\b/i,
];

/** True when the command matches a destructive shape and must be confirmed. */
export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

/** True when the command elevates privileges and therefore needs a password. */
export function requiresSudo(command: string): boolean {
  return /(?:^|[;&|]\s*|\bthen\s+|\bdo\s+)sudo\b|\bsudo\s+-/.test(command);
}
