/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isRecord } from '../utils/markdownUtils.js';
import { applyWorkspaceEditToDisk, fileToUri } from './edits.js';
import type {
  Diagnostic,
  LspClientStatus,
  LspJsonRpcId,
  LspJsonRpcNotification,
  LspJsonRpcRequest,
  LspJsonRpcResponse,
  OpenFile,
  PendingRequest,
  PublishedDiagnostics,
  ServerCapabilities,
  ServerConfig,
  TextDocumentIdentifier,
  WorkspaceEdit,
} from './types.js';

// =============================================================================
// Timing
// =============================================================================

/** Deadline for the `initialize` handshake during warmup/start. */
export const WARMUP_TIMEOUT_MS = 5000;
/** Deadline applied to a request with no explicit timeout and no abort signal. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** How long `waitForProjectLoaded` waits before resolving on its own. */
export const PROJECT_LOAD_TIMEOUT_MS = 15_000;
/** Period of the idle-client sweep. */
export const IDLE_CHECK_INTERVAL_MS = 60_000;
/**
 * A server whose initialize deterministically failed is not re-spawned for this
 * long; every call in the window returns the same typed error instead of paying
 * the full init wait again.
 */
export const INIT_FAILURE_BACKOFF_MS = 3 * 60 * 1000;
/** Grace period for a graceful `shutdown` before the process is killed. */
const SHUTDOWN_TIMEOUT_MS = 5000;
/** Grace period for the process to actually exit after `exit`. */
const EXIT_TIMEOUT_MS = 1000;

// =============================================================================
// Typed Errors
// =============================================================================

export type LspClientErrorCode =
  | 'spawn_failed'
  | 'initialize_failed'
  | 'initialize_timeout'
  | 'not_running'
  | 'request_timeout'
  | 'request_failed'
  | 'aborted'
  | 'connection_closed'
  | 'init_backoff';

/** Every failure this client reports is one of these, never a bare Error. */
export class LspClientError extends Error {
  constructor(
    readonly code: LspClientErrorCode,
    message: string,
    options?: { method?: string; cause?: unknown },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'LspClientError';
    if (options?.method !== undefined) this.method = options.method;
  }

  /** The LSP method that failed, when the failure is request-scoped. */
  readonly method?: string;
}

// =============================================================================
// Client Capabilities
// =============================================================================

const SYMBOL_KIND_VALUE_SET = Array.from(
  { length: 26 },
  (_, index) => index + 1,
);

const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: {
      didSave: true,
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
    },
    hover: {
      contentFormat: ['markdown', 'plaintext'],
      dynamicRegistration: false,
    },
    definition: { dynamicRegistration: false, linkSupport: true },
    typeDefinition: { dynamicRegistration: false, linkSupport: true },
    implementation: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentSymbol: {
      dynamicRegistration: false,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: SYMBOL_KIND_VALUE_SET },
    },
    rename: { dynamicRegistration: false, prepareSupport: true },
    codeAction: {
      dynamicRegistration: false,
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: [
            'quickfix',
            'refactor',
            'refactor.extract',
            'refactor.inline',
            'refactor.rewrite',
            'source',
            'source.organizeImports',
            'source.fixAll',
          ],
        },
      },
      resolveSupport: { properties: ['edit'] },
    },
    formatting: { dynamicRegistration: false },
    rangeFormatting: { dynamicRegistration: false },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: true,
      tagSupport: { valueSet: [1, 2] },
      codeDescriptionSupport: true,
      dataSupport: true,
    },
    diagnostic: { dynamicRegistration: true },
  },
  window: { workDoneProgress: true },
  workspace: {
    applyEdit: true,
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: ['create', 'rename', 'delete'],
      failureHandling: 'abort',
    },
    configuration: true,
    workspaceFolders: true,
    symbol: {
      dynamicRegistration: false,
      symbolKind: { valueSet: SYMBOL_KIND_VALUE_SET },
    },
    fileOperations: {
      dynamicRegistration: false,
      willCreate: false,
      didCreate: false,
      willRename: true,
      didRename: true,
      willDelete: false,
      didDelete: false,
    },
  },
} as const;

/** Applies a server-pushed `workspace/applyEdit`; resolved through the callback. */
export type ApplyEditHandler = (
  edit: WorkspaceEdit,
  targetDir: string,
) => Promise<void> | void;

/** Applied to every file this client mutates on the server's behalf. */
export type WorkspaceEditObserver = (uri: string) => void;

const LANGUAGE_ID_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.rs': 'rust',
  '.go': 'go',
  '.mod': 'go.mod',
  '.sum': 'go.sum',
  '.py': 'python',
  '.pyi': 'python',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.gemspec': 'ruby',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.m': 'objective-c',
  '.mm': 'objective-cpp',
  '.cs': 'csharp',
  '.csx': 'csharp',
  '.swift': 'swift',
  '.hs': 'haskell',
  '.lhs': 'haskell',
  '.ml': 'ocaml',
  '.mli': 'ocaml',
  '.zig': 'zig',
  '.lua': 'lua',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.zsh': 'shellscript',
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
  '.php': 'php',
  '.phtml': 'php',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.heex': 'elixir',
  '.erl': 'erlang',
  '.hrl': 'erlang',
  '.scala': 'scala',
  '.sbt': 'scala',
  '.gleam': 'gleam',
  '.odin': 'odin',
  '.nix': 'nix',
  '.dart': 'dart',
  '.elm': 'elm',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.tf': 'terraform',
  '.tfvars': 'terraform',
  '.hcl': 'hcl',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.sql': 'sql',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.tex': 'latex',
  '.bib': 'bibtex',
  '.cmake': 'cmake',
  '.prisma': 'prisma',
};

/** Best-effort language id for a file path when the config declares none. */
export function inferLanguageId(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'cmakelists.txt') return 'cmake';
  if (base === 'dockerfile' || base.endsWith('.dockerfile'))
    return 'dockerfile';
  return (
    LANGUAGE_ID_BY_EXTENSION[path.extname(base).toLowerCase()] ?? 'plaintext'
  );
}

// =============================================================================
// Message Framing
// =============================================================================

/**
 * `Content-Length` framing. Holds the unparsed tail between chunks and yields
 * whole message bodies, resyncing past header blocks that carry no length.
 */
class MessageFramer {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(buffer?: Buffer) {
    if (buffer?.length) this.buffer = buffer;
  }

  push(chunk: Buffer): void {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  remainder(): Buffer {
    return this.buffer;
  }

  /** Yields every complete message body currently buffered. */
  *drain(onBogusHeader?: (headerText: string) => void): Generator<string> {
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const headerText = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        // Non-protocol bytes on stdout (a wrapper script printing, say): drop
        // past the bogus terminator and resync rather than stalling forever.
        onBogusHeader?.(headerText);
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      yield this.buffer
        .subarray(bodyStart, bodyStart + length)
        .toString('utf-8');
      this.buffer = this.buffer.subarray(bodyStart + length);
    }
  }
}

// =============================================================================
// Wire type guards
// =============================================================================

/** A JSON-RPC id is a number or a string; nothing else is addressable. */
function isLspJsonRpcId(value: unknown): value is LspJsonRpcId {
  return typeof value === 'string' || typeof value === 'number';
}

/** True for a server→client request: a `method` plus an answerable id. */
function isLspJsonRpcRequest(value: unknown): value is LspJsonRpcRequest {
  if (!isRecord(value)) return false;
  const method = value['method'];
  return typeof method === 'string' && isLspJsonRpcId(value['id']);
}

/** True for a server→client notification: a `method` and no id to answer. */
function isLspJsonRpcNotification(
  value: unknown,
): value is LspJsonRpcNotification {
  if (!isRecord(value)) return false;
  const id = value['id'];
  const method = value['method'];
  return typeof method === 'string' && (id === undefined || id === null);
}

interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Diagnostic[];
  version?: number | null;
}

function isPublishDiagnosticsParams(
  value: unknown,
): value is PublishDiagnosticsParams {
  if (!isRecord(value)) return false;
  const uri = value['uri'];
  const version = value['version'];
  return (
    typeof uri === 'string' &&
    (Array.isArray(value['diagnostics']) ||
      value['diagnostics'] === undefined) &&
    (version === undefined || version === null || typeof version === 'number')
  );
}

interface ProgressParams {
  token: string | number;
  value?: { kind?: string };
}

function isProgressParams(value: unknown): value is ProgressParams {
  if (!isRecord(value)) return false;
  if (!isLspJsonRpcId(value['token'])) return false;
  const progressValue = value['value'];
  return progressValue === undefined || isRecord(progressValue);
}

interface ConfigurationParams {
  items?: Array<{ section?: string }>;
}

function isConfigurationParams(value: unknown): value is ConfigurationParams {
  if (!isRecord(value)) return false;
  const items = value['items'];
  if (items === undefined) return true;
  return (
    Array.isArray(items) &&
    items.every((item) => isRecord(item) && isOptionalString(item['section']))
  );
}

interface ApplyEditParams {
  edit?: WorkspaceEdit;
}

function isApplyEditParams(value: unknown): value is ApplyEditParams {
  if (!isRecord(value)) return false;
  const edit = value['edit'];
  return edit === undefined || isRecord(edit);
}

interface RegistrationEntry {
  method?: string;
  id?: string;
}

interface DynamicRegistrationParams {
  registrations?: RegistrationEntry[];
  unregisterations?: RegistrationEntry[];
}

/** Accepts an absent field or a string one. */
function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** Validates the `client/(un)registerCapability` params payload. */
function isDynamicRegistrationParams(
  value: unknown,
  key: keyof DynamicRegistrationParams,
): value is DynamicRegistrationParams {
  if (!isRecord(value)) return false;
  const registrations = value[key];
  if (registrations === undefined) return true;
  return (
    Array.isArray(registrations) &&
    registrations.every(
      (entry) =>
        isRecord(entry) &&
        isOptionalString(entry['method']) &&
        isOptionalString(entry['id']),
    )
  );
}

// =============================================================================
// Client
// =============================================================================

export class LspClient {
  readonly config: ServerConfig;
  readonly targetDir: string;
  /** Registry key: identity of the command plus its resolved binary. */
  readonly name: string;

  status: LspClientStatus = 'connecting';
  /** Last failure, kept so a tool layer can render it instead of catching. */
  lastError: LspClientError | undefined;
  serverCapabilities: ServerCapabilities | undefined;
  readonly diagnostics = new Map<string, PublishedDiagnostics>();
  /** Monotonic counter; bump to invalidate previously observed reports. */
  diagnosticsVersion = 0;
  readonly openFiles = new Map<string, OpenFile>();
  readonly startedAt = Date.now();
  lastActivity = Date.now();

  private proc: ChildProcessWithoutNullStreams | undefined;
  private requestId = 0;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly dynamicRegistrations = new Map<string, string>();
  private readonly activeProgressTokens = new Set<string | number>();
  private framer = new MessageFramer();
  private writeChain: Promise<void> = Promise.resolve();
  private readonly projectLoadedPromise: Promise<void>;
  private resolveProjectLoaded!: () => void;
  private projectLoadTimer: NodeJS.Timeout | undefined;
  private applyEditHandler: ApplyEditHandler | undefined;
  private editObserver: WorkspaceEditObserver | undefined;

  constructor(
    config: ServerConfig,
    targetDir: string,
    opts?: { applyEdit?: ApplyEditHandler },
  ) {
    this.config = config;
    this.targetDir = path.resolve(targetDir);
    this.name = clientKey(config, this.targetDir);
    this.applyEditHandler = opts?.applyEdit;
    this.projectLoadedPromise = new Promise<void>((resolve) => {
      this.resolveProjectLoaded = resolve;
    });
  }

  // -- lifecycle -------------------------------------------------------------

  /**
   * Spawn the server and complete the `initialize` handshake.
   *
   * Never rejects: a failure is recorded in {@link lastError} and leaves the
   * client in `error` status, so callers render a typed error instead of
   * crashing on an unhandled rejection.
   */
  async start(): Promise<void> {
    if (this.status === 'ready') return;
    if (this.status === 'error' && this.lastError) return;

    const command = this.config.resolvedCommand ?? this.config.command;
    const args = this.config.args ?? [];
    try {
      this.proc = spawn(command, args, {
        cwd: this.targetDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      });
    } catch (error) {
      this.fail(
        'spawn_failed',
        `LSP server ${this.config.command} could not be spawned: ${describe(error)}`,
        error,
      );
      return;
    }

    this.attachStreams(this.proc);

    let exited = false;
    this.proc.once('error', (error) => {
      this.fail(
        'spawn_failed',
        `LSP server ${this.config.command} failed to start: ${describe(error)}`,
        error,
      );
    });
    this.proc.once('exit', (code, signal) => {
      exited = true;
      this.status = 'stopped';
      this.clearProjectLoadTimer();
      this.resolveProjectLoaded();
      this.rejectPending(
        new LspClientError(
          'connection_closed',
          `LSP server ${this.config.command} exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
        ),
      );
    });

    const initTimeoutMs = this.config.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS;
    try {
      const result = await this.request<{ capabilities?: ServerCapabilities }>(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'gemini-cli' },
          rootUri: fileToUri(this.targetDir),
          rootPath: this.targetDir,
          workspaceFolders: [
            {
              uri: fileToUri(this.targetDir),
              name: path.basename(this.targetDir) || 'workspace',
            },
          ],
          capabilities: CLIENT_CAPABILITIES,
          initializationOptions: {
            ...(this.config.initOptions ?? {}),
            ...(this.config.settings ? { settings: this.config.settings } : {}),
          },
        },
        { timeoutMs: initTimeoutMs },
      );
      if (
        typeof result === 'object' &&
        result !== null &&
        'capabilities' in result
      ) {
        this.serverCapabilities = result.capabilities;
      }
      await this.notify('initialized', {});
      this.status = 'ready';
      this.lastError = undefined;
      // Auto-resolve so servers that never emit progress tokens do not stall.
      this.projectLoadTimer = setTimeout(
        () => this.resolveProjectLoaded(),
        PROJECT_LOAD_TIMEOUT_MS,
      );
      this.projectLoadTimer.unref?.();
    } catch (error) {
      const original = error instanceof LspClientError ? error.code : undefined;
      const code: LspClientErrorCode =
        original === 'request_timeout'
          ? 'initialize_timeout'
          : original === 'spawn_failed' || original === 'connection_closed'
            ? original
            : 'initialize_failed';
      this.fail(
        code,
        `${this.config.command} initialize failed: ${describe(error)}`,
        error,
      );
      this.killProcess();
    }

    if (exited && this.status === 'error' && !this.lastError) {
      this.fail(
        'connection_closed',
        `${this.config.command} exited during initialize`,
      );
    }
  }

  isRunning(): boolean {
    return (
      this.status === 'ready' && this.proc !== undefined && !this.proc.killed
    );
  }

  /**
   * Whether bytes can still reach the server. The `initialize` handshake itself
   * runs while the client is still `connecting`, so this deliberately does not
   * require `ready`.
   */
  private canCommunicate(): boolean {
    return (
      this.proc !== undefined && !this.proc.killed && this.status !== 'stopped'
    );
  }

  /** The most recent failure, or `undefined` when the client is healthy. */
  getLastError(): LspClientError | undefined {
    return this.lastError;
  }

  /** Replace the `workspace/applyEdit` handler. Set before {@link start}. */
  setApplyEditHandler(handler: ApplyEditHandler | undefined): void {
    this.applyEditHandler = handler;
  }

  /** Observe files mutated by a server-pushed `workspace/applyEdit`. */
  setWorkspaceEditObserver(observer: WorkspaceEditObserver | undefined): void {
    this.editObserver = observer;
  }

  /**
   * Graceful shutdown: `shutdown` request, `exit` notification, bounded wait,
   * then SIGKILL. Always resolves.
   */
  async stop(): Promise<void> {
    if (this.status === 'stopped') return;
    const proc = this.proc;
    this.status = 'stopped';
    this.clearProjectLoadTimer();
    this.resolveProjectLoaded();
    clients.delete(this.name);

    if (proc && !proc.killed) {
      try {
        await this.request('shutdown', null, {
          timeoutMs: SHUTDOWN_TIMEOUT_MS,
        });
        await this.notify('exit', null);
      } catch {
        // A server that already died or ignores shutdown is killed below.
      }
      const exited = await raceExit(proc, EXIT_TIMEOUT_MS);
      if (!exited) this.killProcess();
    }
    this.rejectPending(
      new LspClientError(
        'not_running',
        `LSP server ${this.config.command} was shut down`,
      ),
    );
    this.proc = undefined;
  }

  // -- request / notify ------------------------------------------------------

  /**
   * Send a request and await its response.
   *
   * Always rejects with an {@link LspClientError}: a timeout or an aborting
   * signal also emits `$/cancelRequest` so the server stops working on it.
   */
  request<T>(
    method: string,
    params: unknown,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    if (!this.canCommunicate()) {
      return Promise.reject(
        new LspClientError(
          'not_running',
          `LSP server ${this.config.command} is not running` +
            (this.lastError ? `: ${this.lastError.message}` : ''),
          { method },
        ),
      );
    }
    if (opts?.signal?.aborted) {
      return Promise.reject(
        new LspClientError('aborted', `LSP request ${method} was aborted`, {
          method,
        }),
      );
    }

    const id = ++this.requestId;
    const request: LspJsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    this.lastActivity = Date.now();

    // With no explicit timeout and no caller-owned deadline, fall back to the
    // default so a pending request can never leak forever.
    const effectiveTimeoutMs =
      opts?.timeoutMs ??
      (opts?.signal ? undefined : DEFAULT_REQUEST_TIMEOUT_MS);

    let timer: NodeJS.Timeout | undefined;
    let rejectRequest: (error: Error) => void = () => {};
    const cancel = () =>
      this.write({
        jsonrpc: '2.0',
        method: '$/cancelRequest',
        params: { id },
      }).catch(() => {});
    const cleanup = () => {
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
      this.pendingRequests.delete(id);
      this.lastActivity = Date.now();
    };
    const onAbort = () => {
      void cancel();
      rejectRequest(
        new LspClientError('aborted', `LSP request ${method} was aborted`, {
          method,
        }),
      );
    };

    const settled = new Promise<T>((resolve, reject) => {
      rejectRequest = reject;
      if (effectiveTimeoutMs !== undefined) {
        timer = setTimeout(() => {
          void cancel();
          reject(
            new LspClientError(
              'request_timeout',
              `LSP request ${method} timed out after ${effectiveTimeoutMs}ms`,
              { method },
            ),
          );
        }, effectiveTimeoutMs);
        timer.unref?.();
      }
      opts?.signal?.addEventListener('abort', onAbort, { once: true });

      this.pendingRequests.set(id, { method, resolve, reject });

      this.write(request).catch((error: unknown) => {
        reject(
          new LspClientError(
            'request_failed',
            `LSP request ${method} could not be sent: ${describe(error)}`,
            { method, cause: error },
          ),
        );
      });
    });

    // Every exit path above (resolve, abort, timeout, write failure) funnels
    // through here, so the pending entry and its deadline are released once.
    return settled.finally(cleanup);
  }

  /** Send a notification. Resolves once the bytes are handed to the stream. */
  async notify(method: string, params: unknown): Promise<void> {
    if (!this.canCommunicate()) {
      throw new LspClientError(
        'not_running',
        `LSP server ${this.config.command} is not running`,
        { method },
      );
    }
    this.lastActivity = Date.now();
    const notification: LspJsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    await this.write(notification);
  }

  // -- documents -------------------------------------------------------------

  /**
   * Open `filePath` with the server if it is not already open; otherwise push
   * the on-disk content as a full-document change. Rejects with a typed error
   * when the server is unavailable or the file cannot be read.
   */
  async ensureFileOpen(filePath: string): Promise<void> {
    const absolute = path.resolve(filePath);
    const uri = fileToUri(absolute);
    let content: string;
    try {
      content = await fs.readFile(absolute, 'utf-8');
    } catch (error) {
      throw new LspClientError(
        'request_failed',
        `Cannot read ${absolute}: ${describe(error)}`,
        { cause: error },
      );
    }

    const open = this.openFiles.get(uri);
    if (!open) {
      const languageId = this.config.languageId ?? inferLanguageId(absolute);
      const now = Date.now();
      this.openFiles.set(uri, {
        version: 1,
        languageId,
        content,
        openedAt: now,
        lastChangeAt: now,
      });
      await this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text: content },
      });
      return;
    }

    if (open.content === content) return;
    const version = (open.version ?? 0) + 1;
    this.openFiles.set(uri, {
      ...open,
      version,
      content,
      lastChangeAt: Date.now(),
    });
    await this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      // Full sync: the client capabilities advertise incremental=1 only for
      // servers that ask; full text is always accepted and never misapplied.
      contentChanges: [{ text: content }],
    });
  }

  /** Close a document, tolerating a server that has already forgotten it. */
  async closeFile(filePath: string): Promise<void> {
    const uri = fileToUri(path.resolve(filePath));
    if (!this.openFiles.delete(uri)) return;
    if (!this.isRunning()) return;
    await this.notify('textDocument/didClose', {
      textDocument: { uri } satisfies TextDocumentIdentifier,
    });
  }

  /** The current in-memory document version, or `undefined` when not open. */
  getOpenFileVersion(filePath: string): number | undefined {
    return (
      this.openFiles.get(fileToUri(path.resolve(filePath)))?.version ??
      undefined
    );
  }

  // -- capabilities ----------------------------------------------------------

  /** True when the server advertises LSP 3.17 pull diagnostics. */
  supportsPullDiagnostics(): boolean {
    if (this.serverCapabilities?.['diagnosticProvider']) return true;
    for (const method of this.dynamicRegistrations.values()) {
      if (method === 'textDocument/diagnostic') return true;
    }
    return false;
  }

  /** True when the server advertised `workspace/willRenameFiles`. */
  supportsWillRenameFiles(): boolean {
    return (
      this.serverCapabilities?.['workspace']?.['fileOperations']?.[
        'willRename'
      ] === true
    );
  }

  getServerCapabilities(): ServerCapabilities | undefined {
    return this.serverCapabilities;
  }

  // -- project load ----------------------------------------------------------

  /**
   * Resolve once every work-done progress token has ended, or after
   * `timeoutMs` for servers that never report progress at all.
   */
  async waitForProjectLoaded(
    timeoutMs: number = PROJECT_LOAD_TIMEOUT_MS,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs));
      timer.unref?.();
    });
    try {
      await Promise.race([this.projectLoadedPromise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // -- internals -------------------------------------------------------------

  private fail(
    code: LspClientErrorCode,
    message: string,
    cause?: unknown,
  ): void {
    const error = new LspClientError(
      code,
      message,
      cause === undefined ? {} : { cause },
    );
    this.lastError = error;
    this.status = 'error';
    this.clearProjectLoadTimer();
    this.resolveProjectLoaded();
    recordInitFailure(this.name, error);
    this.rejectPending(error);
  }

  private clearProjectLoadTimer(): void {
    if (!this.projectLoadTimer) return;
    clearTimeout(this.projectLoadTimer);
    this.projectLoadTimer = undefined;
  }

  private killProcess(): void {
    const proc = this.proc;
    if (!proc || proc.killed) return;
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  private rejectPending(error: LspClientError): void {
    for (const pending of Array.from(this.pendingRequests.values())) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private write(
    message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
  ): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.killed) {
      return Promise.reject(
        new LspClientError(
          'not_running',
          `LSP server ${this.config.command} is not running`,
        ),
      );
    }
    const body = Buffer.from(JSON.stringify(message), 'utf-8');
    const framed = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
      body,
    ]);
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          proc.stdin.write(framed, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
    return this.writeChain;
  }

  private attachStreams(proc: ChildProcessWithoutNullStreams): void {
    proc.stdout.on('data', (chunk: Buffer) => {
      this.framer.push(chunk);
      try {
        for (const body of this.framer.drain()) this.handleMessage(body);
      } catch {
        // A malformed message must not kill the reader; later ones are fine.
      }
    });
    proc.stdout.on('error', () => {
      /* surfaced through the 'exit' handler */
    });
    proc.stderr.on('data', () => {
      /* servers are chatty on stderr; the protocol is on stdout */
    });
    proc.stderr.on('error', () => {
      /* ignore */
    });
  }

  private handleMessage(body: string): void {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    const record = message;

    // Disambiguate on `method` first: server request ids live in the server's
    // own id space and routinely collide with our in-flight client ids.
    if (isLspJsonRpcRequest(record)) {
      void this.handleServerRequest(record);
      return;
    }
    if (isLspJsonRpcNotification(record)) {
      this.handleServerNotification(record);
      return;
    }

    if (record['id'] === undefined || record['id'] === null) return;
    const id = record['id'];
    if (typeof id !== 'number') return;
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    const errorField = record['error'];
    if (isRecord(errorField)) {
      const code = errorField['code'];
      const message = errorField['message'];
      pending.reject(
        new LspClientError(
          'request_failed',
          `LSP error${typeof code === 'number' ? ` ${code}` : ''}: ${String(message)}`,
          { method: pending.method },
        ),
      );
      return;
    }
    pending.resolve(record['result']);
  }

  private handleServerNotification(message: LspJsonRpcNotification): void {
    if (message.method === 'textDocument/publishDiagnostics') {
      if (!isPublishDiagnosticsParams(message.params) || !message.params.uri)
        return;
      const params = message.params;
      this.diagnostics.set(params.uri, {
        diagnostics: Array.isArray(params.diagnostics)
          ? params.diagnostics
          : [],
        version: params.version ?? null,
      });
      this.diagnosticsVersion += 1;
      return;
    }
    if (message.method === '$/progress') {
      if (!isProgressParams(message.params)) return;
      const params = message.params;
      if (params.value?.kind === 'begin')
        this.activeProgressTokens.add(params.token);
      else if (params.value?.kind === 'end') {
        this.activeProgressTokens.delete(params.token);
        if (this.activeProgressTokens.size === 0) this.resolveProjectLoaded();
      }
    }
  }

  private async handleServerRequest(message: LspJsonRpcRequest): Promise<void> {
    const respond = (result: unknown) => this.respond(message.id, result);
    const respondError = (code: number, errorMessage: string) =>
      this.respondError(message.id, code, errorMessage);

    switch (message.method) {
      case 'workspace/configuration': {
        const params = isConfigurationParams(message.params)
          ? message.params
          : undefined;
        const settings = this.config.settings ?? {};
        respond(
          (params?.items ?? []).map((item) => {
            const section = item.section ?? '';
            return settings[section] ?? null;
          }),
        );
        return;
      }
      case 'workspace/workspaceFolders': {
        respond([
          {
            uri: fileToUri(this.targetDir),
            name: path.basename(this.targetDir) || 'workspace',
          },
        ]);
        return;
      }
      case 'workspace/applyEdit': {
        const params = isApplyEditParams(message.params)
          ? message.params
          : undefined;
        if (!params?.edit) {
          respond({ applied: false, failureReason: 'No edit provided' });
          return;
        }
        try {
          if (this.applyEditHandler) {
            await this.applyEditHandler(params.edit, this.targetDir);
          } else {
            await applyWorkspaceEditToDisk(params.edit, {
              cwd: this.targetDir,
              onExecuted: (change) => {
                for (const uri of changedUris(change)) this.editObserver?.(uri);
              },
            });
          }
          respond({ applied: true });
        } catch (error) {
          respond({ applied: false, failureReason: describe(error) });
        }
        return;
      }
      case 'window/workDoneProgress/create':
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/codeLens/refresh':
      case 'workspace/codeAction/refresh':
      case 'workspace/inlineValue/refresh':
      case 'workspace/foldingRange/refresh':
      case 'workspace/diagnostic/refresh':
        // Void acknowledgement per spec; servers that block on the reply stall
        // forever, so answer before doing any work.
        if (message.method === 'client/registerCapability') {
          this.recordRegistrations(message);
        } else if (message.method === 'client/unregisterCapability') {
          this.removeRegistrations(message);
        }
        respond(null);
        return;
      case 'window/showMessageRequest':
        // Headless: no UI to surface the prompt. Spec says null = no action.
        respond(null);
        return;
      case 'window/showDocument':
        // Headless: nothing to display. Spec result is `{ success: boolean }`.
        respond({ success: false });
        return;
      default:
        respondError(-32601, `Method not found: ${message.method}`);
    }
  }

  private recordRegistrations(message: LspJsonRpcRequest): void {
    if (!isDynamicRegistrationParams(message.params, 'registrations')) return;
    for (const registration of message.params['registrations'] ?? []) {
      if (registration.method)
        this.dynamicRegistrations.set(
          registration.id ?? registration.method,
          registration.method,
        );
    }
  }

  private removeRegistrations(message: LspJsonRpcRequest): void {
    if (!isDynamicRegistrationParams(message.params, 'unregisterations'))
      return;
    for (const registration of message.params['unregisterations'] ?? []) {
      const key = registration.id ?? registration.method;
      if (key) this.dynamicRegistrations.delete(key);
    }
  }

  private respond(id: LspJsonRpcId, result: unknown): void {
    void this.write({ jsonrpc: '2.0', id, result }).catch(() => {
      // The server is gone; there is nobody left to answer.
    });
  }

  private respondError(id: LspJsonRpcId, code: number, message: string): void {
    void this.write({ jsonrpc: '2.0', id, error: { code, message } }).catch(
      () => {
        // The server is gone; there is nobody left to answer.
      },
    );
  }
}

function changedUris(change: {
  kind: string;
  uri?: string;
  oldUri?: string;
  newUri?: string;
}): string[] {
  if (change.kind === 'rename')
    return [change.oldUri, change.newUri].filter((u): u is string => !!u);
  return change.uri ? [change.uri] : [];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function raceExit(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null)
    return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// =============================================================================
// Registry
// =============================================================================

const clients = new Map<string, LspClient>();
const startingClients = new Map<string, Promise<LspClient>>();
const initFailures = new Map<string, { at: number; error: LspClientError }>();

/**
 * Identity of a server process AND its initialization: everything that decides
 * whether an existing process can be reused for a new request.
 */
export function clientKey(config: ServerConfig, targetDir: string): string {
  const command = config.resolvedCommand ?? config.command;
  return JSON.stringify([path.resolve(targetDir), command, config.args ?? []]);
}

function recordInitFailure(key: string, error: LspClientError): void {
  initFailures.set(key, { at: Date.now(), error });
}

/** Let an explicit reload retry an initialization failure immediately. */
export function clearInitializationFailure(
  config: ServerConfig,
  targetDir: string,
): void {
  initFailures.delete(clientKey(config, targetDir));
}

/**
 * Return the live client for this config, starting one if needed.
 *
 * Never rejects. A server that cannot start — or that failed to initialize
 * within the backoff window — comes back as a client in `error` status whose
 * {@link LspClient.getLastError} explains why, so the tool layer renders an
 * error instead of propagating an exception.
 */
export async function getOrCreateLspClient(
  config: ServerConfig,
  targetDir: string,
): Promise<LspClient> {
  const key = clientKey(config, targetDir);
  const existing = clients.get(key);
  if (existing && existing.status !== 'stopped') {
    existing.lastActivity = Date.now();
    return existing;
  }

  const starting = startingClients.get(key);
  if (starting) return starting;

  // Fail fast on a recent deterministic init failure instead of re-spawning a
  // broken server (and paying its full init wait) on every call.
  const recentFailure = initFailures.get(key);
  if (recentFailure) {
    if (Date.now() - recentFailure.at < INIT_FAILURE_BACKOFF_MS) {
      const failed = new LspClient(
        { ...config, resolvedCommand: config.resolvedCommand },
        targetDir,
      );
      failed.lastError = recentFailure.error;
      failed.status = 'error';
      return failed;
    }
    initFailures.delete(key);
  }

  const client = new LspClient(config, targetDir);

  const startup = client
    .start()
    .then(() => {
      startingClients.delete(key);
      if (client.status === 'ready') clients.set(key, client);
      return client;
    })
    .catch((error: unknown) => {
      startingClients.delete(key);
      client.lastError = new LspClientError(
        'initialize_failed',
        `${config.command} failed to start: ${describe(error)}`,
        { cause: error },
      );
      client.status = 'error';
      return client;
    });
  startingClients.set(key, startup);
  return startup;
}

/** Snapshot of every live client, for a `status` rendering. */
export interface LspServerStatus {
  name: string;
  command: string;
  targetDir: string;
  status: LspClientStatus;
  fileTypes: string[];
  error?: string;
}

export function getActiveLspClients(): LspServerStatus[] {
  return Array.from(clients.values()).map((client) => ({
    name: client.config.command,
    command: client.config.command,
    targetDir: client.targetDir,
    status: client.status,
    fileTypes: client.config.fileTypes,
    ...(client.lastError ? { error: client.lastError.message } : {}),
  }));
}

/** Gracefully stop every client, including ones still mid-initialize. */
export async function shutdownAllLspClients(): Promise<void> {
  stopIdleSweep();
  initFailures.clear();
  const live = Array.from(clients.values());
  clients.clear();
  const pending = Array.from(startingClients.values());
  startingClients.clear();
  const seen = new Set<LspClient>(live);
  await Promise.allSettled([
    ...live.map((client) => client.stop()),
    ...pending.map(async (promise) => {
      const client = await promise;
      if (seen.has(client)) return;
      seen.add(client);
      await client.stop();
    }),
  ]);
}

// =============================================================================
// Idle Sweep
// =============================================================================

let idleTimeoutMs: number | null = null;
let idleSweep: NodeJS.Timeout | null = null;

/** Shut clients down after `ms` of inactivity. `null`/`0` disables the sweep. */
export function setLspIdleTimeout(ms: number | null | undefined): void {
  idleTimeoutMs = ms && ms > 0 ? ms : null;
  if (idleTimeoutMs === null) stopIdleSweep();
  else startIdleSweep();
}

/** True when a client has no pending work and has been quiet long enough. */
export function isIdleClient(
  client: LspClient,
  now: number,
  timeoutMs: number,
): boolean {
  if (client.openFiles.size > 0) return false;
  return now - client.lastActivity >= timeoutMs;
}

/** Stop every client past the idle window. Exported for the tool layer's `reload`. */
export async function checkIdleLspClients(): Promise<void> {
  if (idleTimeoutMs === null) return;
  const now = Date.now();
  for (const client of Array.from(clients.values())) {
    if (isIdleClient(client, now, idleTimeoutMs)) {
      clients.delete(client.name);
      await client.stop();
    }
  }
}

function startIdleSweep(): void {
  if (idleSweep) return;
  idleSweep = setInterval(() => {
    void checkIdleLspClients();
  }, IDLE_CHECK_INTERVAL_MS);
  idleSweep.unref?.();
}

function stopIdleSweep(): void {
  if (!idleSweep) return;
  clearInterval(idleSweep);
  idleSweep = null;
}
