/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileToUri } from './edits.js';
import type { LspClient } from './client.js';
import type { Diagnostic, DocumentDiagnosticReport } from './types.js';

/** Default single-file wait budget. */
export const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3000;
/**
 * Longer budget for project-aware servers (Roslyn, tsserver, …): their first
 * pull-diagnostic response computes analysis on demand and routinely overruns
 * {@link SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS}.
 */
export const PROJECT_DIAGNOSTICS_WAIT_TIMEOUT_MS = 10_000;
/** Poll period while waiting for a publish. */
export const DIAGNOSTICS_POLL_MS = 100;
/**
 * Quiescence window. Some servers (typescript-language-server among them) never
 * echo the document version and emit reports from several sources at different
 * times, so there is no single version-matched publish to gate on. When the
 * server does not exact-version-match, the latest publish is accepted only after
 * no newer one has arrived for this long.
 */
export const DIAGNOSTICS_SETTLE_MS = 250;
/**
 * How long an empty unversioned publish from a freshly started server is
 * treated as a pre-analysis placeholder rather than a clean file.
 */
const PROVISIONAL_COLD_PUBLISH_MS = 12_000;

export interface WaitForDiagnosticsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Only accept a report published after this `diagnosticsVersion` snapshot. */
  minVersion?: number;
  /** The document version the caller expects the server to echo back. */
  expectedDocumentVersion?: number;
  /** Quiescence window; defaults to {@link DIAGNOSTICS_SETTLE_MS}. */
  settleMs?: number;
}

interface PullOutcome {
  diagnostics?: Diagnostic[];
  failed?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

function requestPullDiagnostics(
  client: LspClient,
  filePath: string,
  timeoutMs: number,
): Promise<PullOutcome> {
  return client
    .request<DocumentDiagnosticReport>(
      'textDocument/diagnostic',
      { textDocument: { uri: fileToUri(filePath) } },
      { timeoutMs },
    )
    .then((report) => {
      // Only a `full` report carries items; `unchanged` means "same as last".
      if (report?.kind !== 'full' || !Array.isArray(report.items)) return {};
      return { diagnostics: report.items };
    })
    .catch((error: unknown) => ({ failed: error }));
}

function isProvisionalColdPublish(
  client: LspClient,
  version: number | null,
  diagnostics: readonly Diagnostic[],
  expectedDocumentVersion: number | undefined,
  now: number,
): boolean {
  return (
    expectedDocumentVersion !== undefined &&
    version === null &&
    diagnostics.length === 0 &&
    now - client.startedAt < PROVISIONAL_COLD_PUBLISH_MS
  );
}

/**
 * Wait for a diagnostics report for `filePath`.
 *
 * Both transports are supported: push (`textDocument/publishDiagnostics`,
 * tracked by the client) and LSP 3.17 pull (`textDocument/diagnostic`, attempted
 * once when the server advertises it). A publish that echoes the caller's exact
 * document version is authoritative and returned immediately; otherwise the
 * latest publish is accepted after it has been quiet for `settleMs`.
 *
 * A failed pull is never collapsed into "clean": it rejects, because the file's
 * real state is unknown.
 */
export async function waitForDiagnostics(
  client: LspClient,
  filePath: string,
  options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
  const {
    timeoutMs = SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS,
    signal,
    minVersion,
    expectedDocumentVersion,
    settleMs = DIAGNOSTICS_SETTLE_MS,
  } = options;

  const uri = fileToUri(filePath);
  const deadline = Date.now() + timeoutMs;
  let pull: Promise<PullOutcome> | undefined;
  let pulled: Diagnostic[] | undefined;
  let pullFailure: unknown;
  let settledDiagnostics: Diagnostic[] | undefined;
  let settledAt = 0;

  const currentReport = () => {
    if (minVersion !== undefined && client.diagnosticsVersion <= minVersion)
      return undefined;
    return client.diagnostics.get(uri);
  };

  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError(signal);

    if (!pull && client.supportsPullDiagnostics()) {
      pull = requestPullDiagnostics(
        client,
        filePath,
        Math.max(1, deadline - Date.now()),
      );
    }

    const published = currentReport();
    if (published) {
      if (
        expectedDocumentVersion !== undefined &&
        published.version === expectedDocumentVersion
      ) {
        return published.diagnostics;
      }
      const now = Date.now();
      if (published.diagnostics !== settledDiagnostics) {
        settledDiagnostics = published.diagnostics;
        settledAt = now;
      } else if (
        now - settledAt >= settleMs &&
        !isProvisionalColdPublish(
          client,
          published.version,
          published.diagnostics,
          expectedDocumentVersion,
          now,
        )
      ) {
        return published.diagnostics;
      }
    }

    const pollMs = Math.min(
      DIAGNOSTICS_POLL_MS,
      Math.max(0, deadline - Date.now()),
    );
    if (!pull) {
      await sleep(pollMs);
      continue;
    }
    const outcome = await Promise.race([
      pull,
      sleep(pollMs).then(() => undefined),
    ]);
    if (!outcome) continue;
    pull = undefined;
    if (outcome.diagnostics !== undefined) {
      pulled = outcome.diagnostics;
      break;
    }
    // A pull failure leaves the report unknown, but a dual-mode server may still
    // publish a fresh report within the remaining budget.
    if (outcome.failed !== undefined) pullFailure = outcome.failed;
  }

  const published = currentReport();
  if (published) {
    if (
      expectedDocumentVersion !== undefined &&
      published.version === expectedDocumentVersion
    ) {
      return published.diagnostics;
    }
    const now = Date.now();
    if (
      published.diagnostics === settledDiagnostics &&
      now - settledAt >= settleMs &&
      !isProvisionalColdPublish(
        client,
        published.version,
        published.diagnostics,
        expectedDocumentVersion,
        now,
      )
    ) {
      return published.diagnostics;
    }
  }

  if (pull) {
    const outcome = await pull;
    if (outcome.diagnostics !== undefined) pulled = outcome.diagnostics;
    else if (outcome.failed !== undefined) pullFailure = outcome.failed;
  }
  if (signal?.aborted) throw abortError(signal);

  if (pulled === undefined) {
    if (pullFailure !== undefined) {
      throw pullFailure instanceof Error
        ? pullFailure
        : new Error(String(pullFailure));
    }
    return [];
  }

  // Record the pull so a later push for the same version is not double counted.
  client.diagnostics.set(uri, {
    diagnostics: pulled,
    version:
      expectedDocumentVersion ?? client.getOpenFileVersion(filePath) ?? null,
  });
  client.diagnosticsVersion += 1;
  return pulled;
}

/** Per-server `diagnosticsVersion` snapshot, captured before an edit. */
export type ServerVersionMap = Map<string, number>;

/**
 * Snapshot every client's current `diagnosticsVersion` so a later wait can
 * reject reports that predate the edit.
 */
export function captureDiagnosticVersions(
  clients: Iterable<readonly [string, LspClient]>,
): ServerVersionMap {
  const versions: ServerVersionMap = new Map();
  for (const [name, client] of clients) {
    versions.set(name, client.diagnosticsVersion);
  }
  return versions;
}

/** The in-memory document version for a file, when it is open on a client. */
export function captureOpenFileVersion(
  client: LspClient,
  filePath: string,
): number | undefined {
  return client.getOpenFileVersion(filePath);
}

function diagnosticKey(diagnostic: Diagnostic): string {
  const { start, end } = diagnostic.range;
  return [
    start.line,
    start.character,
    end.line,
    end.character,
    diagnostic.severity ?? 1,
    diagnostic.code ?? '',
    diagnostic.source ?? '',
    diagnostic.message,
  ].join(' ');
}

/**
 * Collapse reports describing the same diagnostic. Several servers (and
 * several rounds of one server) repeat the same finding; keying on position,
 * severity, code, source, and message leaves one copy.
 */
export function dedupeDiagnostics(
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(diagnostic);
  }
  return unique;
}

/** Sort by severity, then position, then message. */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.sort((a, b) => {
    const severity = (a.severity ?? 1) - (b.severity ?? 1);
    if (severity !== 0) return severity;
    const line = a.range.start.line - b.range.start.line;
    if (line !== 0) return line;
    const column = a.range.start.character - b.range.start.character;
    if (column !== 0) return column;
    return a.message.localeCompare(b.message);
  });
}
