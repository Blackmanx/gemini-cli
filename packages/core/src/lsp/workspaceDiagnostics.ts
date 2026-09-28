/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isRecord } from '../utils/markdownUtils.js';

/** Languages whose native type checker can run without a language server. */
export type WorkspaceProjectType = 'rust' | 'typescript' | 'go' | 'python';

export interface WorkspaceDiagnostic {
  file?: string;
  /** 1-based line number as printed by the checker. */
  line?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
}

export interface WorkspaceDiagnosticsResult {
  detected: string;
  diagnostics: WorkspaceDiagnostic[];
  /** The command that was run, for display. */
  command: string;
  /** True when the checker ran and reported a clean workspace. */
  ok: boolean;
  output: string;
}

/** Cap on captured output so one noisy checker cannot flood the transcript. */
const MAX_OUTPUT_LINES = 50;
/** Hard deadline for a checker that hangs. */
const DEFAULT_TIMEOUT_MS = 120_000;

const PROJECT_MARKERS: ReadonlyArray<{
  type: WorkspaceProjectType;
  markers: readonly string[];
}> = [
  { type: 'rust', markers: ['Cargo.toml'] },
  { type: 'typescript', markers: ['tsconfig.json'] },
  // A go.work workspace is one project made of several modules, not a language
  // of its own, so it is checked as Go rather than as a separate type.
  { type: 'go', markers: ['go.work', 'go.mod'] },
  { type: 'python', markers: ['pyproject.toml', 'pyrightconfig.json'] },
];

const CHECKER_COMMANDS: Record<
  WorkspaceProjectType,
  { command: string; args: string[] }
> = {
  rust: { command: 'cargo', args: ['check', '--message-format=short'] },
  typescript: { command: 'npx', args: ['tsc', '--noEmit'] },
  go: { command: 'go', args: ['build', './...'] },
  python: { command: 'pyright', args: [] },
};

function markerExists(targetDir: string, name: string): boolean {
  try {
    fs.accessSync(path.join(targetDir, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the project type from the workspace root, or `null` when the root
 * carries no recognised marker. A polyglot root reports the highest-priority
 * match, in the order the markers are listed.
 */
export function detectProjectType(
  targetDir: string,
): WorkspaceProjectType | null {
  for (const entry of PROJECT_MARKERS) {
    if (entry.markers.some((marker) => markerExists(targetDir, marker)))
      return entry.type;
  }
  return null;
}

interface CaptureResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** Set when the process could not run at all, or was killed before finishing. */
  spawnError?: string;
}

function runCapture(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  if (signal?.aborted) {
    return Promise.resolve({
      stdout: '',
      stderr: '',
      code: null,
      spawnError: 'aborted',
    });
  }

  return new Promise<CaptureResult>((resolve) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: { code: number | null; spawnError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout,
        stderr,
        code: result.code,
        ...(result.spawnError ? { spawnError: result.spawnError } : {}),
      });
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      finish({ code: null, spawnError: 'aborted' });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, spawnError: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (error: Error) =>
      finish({ code: null, spawnError: error.message }),
    );
    child.on('close', (code) => finish({ code }));
  });
}

/** Turn a `go.work` module directory into the package pattern `go build` needs. */
function goWorkspaceBuildPattern(diskPath: string): string | null {
  const trimmed = diskPath.trim();
  if (!trimmed) return null;
  const isAbsolute = path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed);
  const normalized = trimmed.replaceAll('\\', '/').replace(/\/+$/, '');
  const dir = normalized || '.';
  if (dir === '.') return './...';
  if (dir.endsWith('/...')) return dir;
  if (isAbsolute || dir.startsWith('./') || dir.startsWith('../'))
    return `${dir}/...`;
  return `./${dir}/...`;
}

/** Parse `go work edit -json` into one build pattern per used module. */
function parseGoWorkspaceBuildPatterns(output: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['Use'])) return [];
  const patterns = new Set<string>();
  for (const entry of parsed['Use'] as unknown[]) {
    if (!isRecord(entry)) continue;
    const diskPath = entry['DiskPath'];
    if (typeof diskPath !== 'string') continue;
    const pattern = goWorkspaceBuildPattern(diskPath);
    if (pattern) patterns.add(pattern);
  }
  return [...patterns];
}

/**
 * Build the `go build` invocation for a workspace root: a `go.work` workspace is
 * honoured by asking the toolchain for every module it uses, falling back to
 * `./...` when that lookup is unavailable.
 */
async function resolveGoCommand(
  targetDir: string,
  timeoutMs: number,
): Promise<{ command: string; args: string[] }> {
  const fallback = { command: 'go', args: ['build', './...'] };
  if (!markerExists(targetDir, 'go.work')) return fallback;
  const probe = await runCapture(
    'go',
    ['work', 'edit', '-json'],
    targetDir,
    timeoutMs,
  );
  if (probe.code !== 0 || probe.spawnError) return fallback;
  const patterns = parseGoWorkspaceBuildPatterns(probe.stdout);
  return patterns.length > 0
    ? { command: 'go', args: ['build', ...patterns] }
    : fallback;
}

// =============================================================================
// Output Parsers
// =============================================================================

/** `src/main.rs:12:5: error[E0308]: mismatched types` (cargo --message-format=short). */
const CARGO_LINE =
  /^(.+?):(\d+):(\d+):\s+(error|warning)(?:\[([A-Za-z0-9]+)\])?:\s+(.*)$/;
const CARGO_FILE_ONLY =
  /^(.+?):(\d+):\s+(error|warning)(?:\[([A-Za-z0-9]+)\])?:\s+(.*)$/;

/** `src/a.ts(12,5): error TS2322: Type 'x' is not assignable` (tsc). */
const TSC_LINE =
  /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+):\s+(.*)$/;
const TSC_GLOBAL = /^(error|warning|info)\s+(TS\d+):\s+(.*)$/;

/** `./main.go:6:2: undefined: fmt.Println` (go build). */
const GO_LINE = /^(\.\/?[^\s:]+):(\d+)(?::(\d+))?:\s+(.*)$/;

/** `  /path/file.py:12:5 - error: message  [reportGeneral]` (pyright). */
const PYRIGHT_LINE =
  /^\s*(.+?):(\d+):(\d+)\s+-\s+(error|warning|information):\s+(.*?)(?:\s+\[\w+\])?$/;
const PYRIGHT_SUMMARY = /^\s*\d+\s+(error|warning|information)s?\s+and\s+\d+/;

function severityOf(raw: string): WorkspaceDiagnostic['severity'] {
  if (raw === 'warning') return 'warning';
  if (raw === 'info' || raw === 'information') return 'info';
  return 'error';
}

function parseCargo(output: string): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = [];
  for (const line of output.split('\n')) {
    const match = CARGO_LINE.exec(line) ?? CARGO_FILE_ONLY.exec(line);
    if (!match) continue;
    const [, file, lineNumber, severity, code, message] = match;
    diagnostics.push({
      file,
      line: Number(lineNumber),
      severity: severityOf(severity),
      message: message.trim(),
      ...(code ? { code } : {}),
    });
  }
  return diagnostics;
}

function parseTsc(output: string): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = [];
  for (const line of output.split('\n')) {
    const located = TSC_LINE.exec(line);
    if (located) {
      const [, file, lineNumber, , severity, code, message] = located;
      diagnostics.push({
        file,
        line: Number(lineNumber),
        severity: severityOf(severity),
        message: message.trim(),
        code,
      });
      continue;
    }
    // A configuration-level error (a malformed tsconfig) has no location.
    const global = TSC_GLOBAL.exec(line);
    if (global) {
      const [, severity, code, message] = global;
      diagnostics.push({
        severity: severityOf(severity),
        message: message.trim(),
        code,
      });
    }
  }
  return diagnostics;
}

function parseGo(output: string): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = [];
  for (const line of output.split('\n')) {
    // `go build` prefixes build failures with `# package` headers, which name a
    // package rather than a position.
    if (line.startsWith('# ')) continue;
    const match = GO_LINE.exec(line.trim());
    if (!match) continue;
    const [, file, lineNumber, , message] = match;
    diagnostics.push({
      file,
      line: Number(lineNumber),
      severity: 'error',
      message: message.trim(),
    });
  }
  return diagnostics;
}

function parsePyright(output: string): WorkspaceDiagnostic[] {
  const diagnostics: WorkspaceDiagnostic[] = [];
  for (const line of output.split('\n')) {
    if (PYRIGHT_SUMMARY.test(line)) continue;
    const match = PYRIGHT_LINE.exec(line);
    if (!match) continue;
    const [, file, lineNumber, severity, message] = match;
    diagnostics.push({
      file,
      line: Number(lineNumber),
      severity: severityOf(severity),
      message: message.trim(),
    });
  }
  return diagnostics;
}

const PARSERS: Record<
  WorkspaceProjectType,
  (output: string) => WorkspaceDiagnostic[]
> = {
  rust: parseCargo,
  typescript: parseTsc,
  go: parseGo,
  python: parsePyright,
};

function capOutput(output: string): string {
  const lines = output.split('\n');
  if (lines.length <= MAX_OUTPUT_LINES) return output;
  return `${lines.slice(0, MAX_OUTPUT_LINES).join('\n')}\n[…${lines.length - MAX_OUTPUT_LINES}ln elided…]`;
}
/**
 * Run the workspace's native type checker and parse its output.
 *
 * No language server is involved, so this works in a repository where no LSP
 * binary is installed. The root marker decides the checker: Rust
 * (`cargo check --message-format=short`), TypeScript (`npx tsc --noEmit`), Go
 * (`go build ./...`, honouring `go.work`), Python (`pyright`).
 *
 * A checker that exits non-zero *without writing a byte* never inspected
 * anything — it failed to start, crashed, or was killed — and is reported as
 * such rather than as a clean workspace.
 */
export async function runWorkspaceDiagnostics(
  targetDir: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<WorkspaceDiagnosticsResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const type = detectProjectType(targetDir);
  if (!type) {
    return {
      detected: 'none',
      diagnostics: [],
      command: '',
      ok: false,
      output:
        'No recognised project root. Supported markers: Cargo.toml (Rust), ' +
        'tsconfig.json (TypeScript), go.mod/go.work (Go), pyproject.toml or ' +
        'pyrightconfig.json (Python).',
    };
  }

  const { command, args } =
    type === 'go'
      ? await resolveGoCommand(targetDir, timeoutMs)
      : CHECKER_COMMANDS[type];

  const result = await runCapture(
    command,
    args,
    targetDir,
    timeoutMs,
    opts?.signal,
  );
  const combined = `${result.stdout}${result.stderr}`.trim();
  const label = `${command} ${args.join(' ')}`.trim();

  if (result.spawnError && !combined) {
    return {
      detected: type,
      diagnostics: [],
      command: label,
      ok: false,
      output: `Failed to run ${label}: ${result.spawnError}`,
    };
  }
  if (result.code !== 0 && !combined) {
    return {
      detected: type,
      diagnostics: [],
      command: label,
      ok: false,
      output: `${label} produced no output (exit ${result.code ?? 'null'}). The checker did not run.`,
    };
  }

  const diagnostics = PARSERS[type](combined);
  return {
    detected: type,
    diagnostics,
    command: label,
    ok: result.code === 0 && diagnostics.length === 0,
    output: capOutput(combined),
  };
}
