/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GhService, type GhResult } from '../services/ghService.js';
import { hasProperty, isStringProperty } from '../utils/typeGuards.js';
import type { SchemeSpec } from './types.js';
import {
  conflictSchemeSpecs,
  ConflictRegistry,
  type ConflictGitHub,
  type ConflictSchemeHost,
  type ConflictSsh,
  type ConflictSshHost,
  type ConflictSshResult,
  type ConflictSshTarget,
} from './conflictSchemes.js';

const execFileAsync = promisify(execFile);

/**
 * The real transports behind `conflict://`, `pr://`, `issue://` and `ssh://`.
 *
 * `internal-urls/conflictSchemes.ts` owns every bit of parsing, filtering and
 * rendering; this file owns only the two things that touch the outside world.
 * The split is deliberate — the schemes stay testable without a `gh` binary or
 * an SSH server, and there is exactly one place where a subprocess is spawned.
 *
 * Both are async. `gh` and `ssh` are network calls; running them synchronously
 * would block the Node event loop and freeze the TUI for the length of a round
 * trip.
 */

class LiveGitHubTransport implements ConflictGitHub {
  private readonly gh: GhService;

  constructor(gh: GhService = new GhService()) {
    this.gh = gh;
  }

  async run(
    args: readonly string[],
    options: { cwd: string },
  ): Promise<GhResult> {
    return this.gh.run(args, options);
  }
}

class LiveSshTransport implements ConflictSsh {
  async hosts(): Promise<readonly ConflictSshHost[]> {
    let stdout = '';
    try {
      const result = await execFileAsync('ssh', ['-G', 'dummy-host'], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (err) {
      // `ssh -G` exits non-zero for a host it cannot resolve, but it still
      // prints what it knows on stderr. Either stream can carry the config.
      stdout = `${readStream(err, 'stdout')}${readStream(err, 'stderr')}`;
      if (stdout.trim() === '') return [];
    }
    return parseSshConfig(stdout);
  }

  async run(
    target: ConflictSshTarget,
    command: string,
  ): Promise<ConflictSshResult> {
    const args = ['-o', 'BatchMode=yes'];
    if (target.port !== undefined) {
      args.push('-p', String(target.port));
    }
    args.push(target.host, command);
    try {
      const { stdout, stderr } = await execFileAsync('ssh', args, {
        encoding: 'utf8',
        // The scheme caps the payload at 1 MiB, so the buffer is sized for
        // stderr plus a little slack rather than unbounded.
        maxBuffer: 2 * 1024 * 1024,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      // A non-zero remote exit is a RESULT the scheme must diagnose, not an
      // exception it should have to guess at: ssh's exit status is the
      // remote command's, and stderr is the explanation.
      const code = numericProperty(err, 'code');
      if (typeof code === 'number') {
        return {
          exitCode: code,
          stdout: readStream(err, 'stdout'),
          stderr: readStream(err, 'stderr'),
        };
      }
      const message = isStringProperty(err, 'message')
        ? err.message
        : String(err);
      throw new Error(
        `cannot run ssh: ${readStream(err, 'stderr') || message || 'ssh is not available'}`,
      );
    }
  }
}

/** A numeric `code` on a spawn failure, when it carries one. */
function numericProperty(err: unknown, prop: 'code'): number | undefined {
  if (!hasProperty(err, prop)) return undefined;
  const value: unknown = err[prop];
  return typeof value === 'number' ? value : undefined;
}

/**
 * One captured stream of a failed spawn, when it carries text.
 *
 * `execFile` attaches `stdout`/`stderr` to the rejection for a non-zero exit,
 * and those are the only place the remote command's output survives.
 */
function readStream(err: unknown, name: 'stdout' | 'stderr'): string {
  return isStringProperty(err, name) ? err[name] : '';
}

/**
 * One `Host` block of `ssh -G` output.
 *
 * `ssh -G host` prints the fully resolved configuration for one host, so it
 * answers "what does this alias mean" without parsing the user's own
 * `~/.ssh/config`, which may include wildcards and `Match` blocks that a naive
 * reader would get wrong.
 */
function parseSshConfig(stdout: string): ConflictSshHost[] {
  const hosts: ConflictSshHost[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    const space = trimmed.indexOf(' ');
    if (space === -1) continue;
    const key = trimmed.slice(0, space).toLowerCase();
    const value = trimmed.slice(space + 1).trim();
    switch (key) {
      case 'host':
        if (value !== '') {
          hosts.push({ name: value });
        }
        break;
      case 'hostname':
        if (hosts.length > 0) hosts[hosts.length - 1].host = value;
        break;
      case 'user':
        if (hosts.length > 0) hosts[hosts.length - 1].username = value;
        break;
      case 'port':
        if (hosts.length > 0) {
          const port = Number.parseInt(value, 10);
          if (Number.isFinite(port)) hosts[hosts.length - 1].port = port;
        }
        break;
      case 'comment':
        if (hosts.length > 0) hosts[hosts.length - 1].description = value;
        break;
      default:
        break;
    }
  }
  // `ssh -G` always echoes back the host it was asked about, even for one that
  // is not in any config file. That is not a configured host the user can
  // meaningfully read, so it is dropped.
  return hosts.filter(
    (h) => h.host !== undefined || h.description !== undefined,
  );
}

/**
 * The host a live router hands to the conflict schemes.
 *
 * Both transports are constructed once: `GhService` and the `ssh` transport
 * are stateless with respect to a session, and rebuilding them per resolve
 * would mean re-resolving `gh` on every `pr://` read.
 */
let processRegistry: ConflictRegistry | undefined;

export function liveConflictSchemeHost(): ConflictSchemeHost {
  // Lazily built and cached: the schemes call these per resolve, and
  // constructing a transport per read would re-resolve `gh` every time.
  //
  // The conflict registry is per-process, which is the right granularity for
  // one CLI session: `conflict://<file>/<id>` mints ids on read, and those ids
  // have to stay stable for as long as the conversation that referred to them.
  let github: ConflictGitHub | undefined;
  let ssh: ConflictSsh | undefined;
  return {
    conflicts: () => (processRegistry ??= new ConflictRegistry()),
    github: () => (github ??= new LiveGitHubTransport()),
    ssh: () => (ssh ??= new LiveSshTransport()),
  };
}

/** The conflict, PR, issue and SSH schemes, wired to the real transports. */
export function liveConflictSchemeSpecs(): SchemeSpec[] {
  return conflictSchemeSpecs(liveConflictSchemeHost());
}
