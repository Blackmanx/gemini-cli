/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getOrCreateLspClient, type LspClient } from './client.js';
import { detectServers, loadLspConfig, matchServerForFile } from './config.js';
import { waitForDiagnostics } from './diagnostics.js';
import type { Diagnostic, ServerConfig } from './types.js';

/**
 * Re-check a file after it was edited and report what the language server
 * says about the NEW content.
 *
 * Ported in spirit from omp's deferred diagnostics. The reason it matters: an
 * edit that type-checks when it lands is a closed loop. Without this, the
 * agent writes a change, the turn ends, and the type error surfaces several
 * turns later in a file the model has since moved on from.
 *
 * The one hard rule: if the server cannot be reached, this must NOT turn a
 * successful edit into a failure. No language server installed is not an edit
 * error, and a slow server must not stall the turn.
 */

/** How long to wait for the server before giving up. */
export const POST_EDIT_DIAGNOSTICS_TIMEOUT_MS = 4000;

/** A queued post-edit check. */
interface PendingCheck {
  file: string;
  server: ServerConfig;
  client: LspClient | undefined;
}

const pending = new Map<string, PendingCheck>();
let inFlight: Promise<void> | undefined;

function serversFor(targetDir: string): ServerConfig[] {
  const config = loadLspConfig(targetDir);
  return Object.values(detectServers(config.servers, targetDir)).filter(
    (server) => server.isLinter === undefined || !server.isLinter,
  );
}

/**
 * Queue a re-check of `file` after an edit.
 *
 * Returns immediately. The caller is on the hot path of every edit, and a
 * language-server round trip there would make every write slow.
 */
export function schedulePostEditDiagnostics(
  file: string,
  targetDir: string,
  signal?: AbortSignal,
): void {
  if (pending.has(file)) return;
  // A linter will always have something to say and a type checker only says
  // something when the edit broke something; the type checker is the useful
  // one here, so a linter match alone is not enough to queue a check.
  const candidates = serversFor(targetDir);
  if (candidates.length === 0) return;
  const server = matchServerForFile(candidates, file);
  if (server === undefined) return;
  pending.set(file, { file, server, client: undefined });
  void signal;

  inFlight ??= (async () => {
    inFlight = undefined;
    const batch = [...pending.values()];
    pending.clear();
    await Promise.all(
      batch.map(async (check) => {
        try {
          check.client = await getOrCreateLspClient(check.server, targetDir);
        } catch {
          // No server: nothing to report, and not an error.
          check.client = undefined;
        }
      }),
    );
  })();
}

export interface PostEditDiagnosticReport {
  file: string;
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Set when the check could not run, so the caller can say why. */
  note?: string;
}

/**
 * Check `file` now and report its diagnostics.
 *
 * A failure to reach the server yields `ok: true` with a `note`, because an
 * unreachable server is not a diagnostic about the code.
 */
export async function collectPostEditDiagnostics(
  file: string,
  targetDir: string,
  signal?: AbortSignal,
): Promise<PostEditDiagnosticReport> {
  const candidates = serversFor(targetDir);
  const server =
    candidates.length > 0 ? matchServerForFile(candidates, file) : undefined;
  if (server === undefined) {
    return {
      file,
      ok: true,
      diagnostics: [],
      note: 'No language server is configured for this file.',
    };
  }
  try {
    const client = await getOrCreateLspClient(server, targetDir);
    await client.ensureFileOpen(file);
    const diagnostics = await waitForDiagnostics(client, file, {
      timeoutMs: POST_EDIT_DIAGNOSTICS_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    return { file, ok: true, diagnostics };
  } catch (err) {
    return {
      file,
      ok: true,
      diagnostics: [],
      note: `Language server check skipped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Render a report as a short line the model can act on. */
export function formatPostEditDiagnostics(
  report: PostEditDiagnosticReport,
): string {
  if (report.diagnostics.length === 0) {
    return report.note ?? `${report.file}: no type errors.`;
  }
  const errors = report.diagnostics.filter((d) => d.severity === 1);
  const head = `${report.file}: ${errors.length} error(s) after the edit.`;
  const lines = report.diagnostics.slice(0, 10).map((d) => {
    const message = d.message.split('\n')[0] ?? d.message;
    return `  ${d.range.start.line + 1}:${d.range.start.character + 1} ${message}`;
  });
  const more =
    report.diagnostics.length > lines.length
      ? `\n  …and ${report.diagnostics.length - lines.length} more.`
      : '';
  return `${head}\n${lines.join('\n')}${more}`;
}

/** Forget any queued checks. Test-only. */
export function resetPostEditDiagnostics(): void {
  pending.clear();
  inFlight = undefined;
}
