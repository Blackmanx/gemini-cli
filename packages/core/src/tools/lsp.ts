/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ExecuteOptions,
  type PolicyUpdateOptions,
  type ToolConfirmationOutcome,
  type ToolInvocation,
  type ToolLocation,
  type ToolResult,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { LSP_TOOL_NAME, LSP_DISPLAY_NAME } from './tool-names.js';
import { LSP_DEFINITION } from './definitions/coreTools.js';
import type { Config } from '../config/config.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  detectServers,
  loadLspConfig,
  matchServerForFile,
  reloadConfigurationParams,
  LSP_READONLY_ACTIONS,
} from '../lsp/config.js';
import {
  clearInitializationFailure,
  getActiveLspClients,
  getOrCreateLspClient,
  type LspClient,
} from '../lsp/client.js';
import {
  applyEditsThenRename,
  applyWorkspaceEditToDisk,
  fileToUri,
  uriToFile,
  type RenameReferenceEdit,
} from '../lsp/edits.js';
import {
  dedupeDiagnostics,
  sortDiagnostics,
  waitForDiagnostics,
} from '../lsp/diagnostics.js';
import { runWorkspaceDiagnostics } from '../lsp/workspaceDiagnostics.js';
import type {
  Diagnostic,
  Location,
  ServerConfig,
  WorkspaceEdit,
} from '../lsp/types.js';

/**
 * The `lsp` tool: everything the agent's language server already knows.
 *
 * Ported from omp's `lsp` tool. The read and write halves are separate tool
 * classes rather than one tool with a dynamic `kind`, because `kind` is what
 * buys read-parallel execution and plan-mode access — a `rename` must not
 * inherit either.
 */

export interface LspToolParams {
  action: string;
  file?: string;
  line?: number;
  symbol?: string;
  query?: string;
  new_name?: string;
  apply?: boolean;
  timeout?: number;
  payload?: unknown;
}

/** Actions that only read. `LSP_READONLY_ACTIONS` is the source of truth. */
const READ_ACTIONS: readonly string[] = [...LSP_READONLY_ACTIONS];

/** Actions that change files, and therefore need confirmation. */
const WRITE_ACTIONS: readonly string[] = [
  'rename',
  'rename_file',
  'code_actions',
];

const DEFAULT_TIMEOUT_SECONDS = 20;

function isLocation(value: unknown): value is Location {
  return (
    typeof value === 'object' &&
    value !== null &&
    'uri' in value &&
    'range' in value
  );
}

function renderLocations(result: unknown, fallbackFile: string): string {
  if (isLocation(result)) {
    return `${uriToFile(result.uri) || fallbackFile}:${result.range.start.line + 1}`;
  }
  if (Array.isArray(result) && result.every(isLocation)) {
    return result
      .map(
        (entry) =>
          `${uriToFile(entry.uri) || fallbackFile}:${entry.range.start.line + 1}`,
      )
      .join('\n');
  }
  return 'No result.';
}

const SEVERITY_NAMES: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

/** Render diagnostics as stable, greppable one-liners. */
function formatDiagnostics(
  file: string,
  diagnostics: readonly Diagnostic[],
): string {
  if (diagnostics.length === 0) return 'OK — no diagnostics.';
  return sortDiagnostics(dedupeDiagnostics([...diagnostics]))
    .map((diagnostic) => {
      const level =
        diagnostic.severity === undefined
          ? 'info'
          : (SEVERITY_NAMES[diagnostic.severity] ?? 'info');
      const code =
        diagnostic.code === undefined ? '' : ` [${String(diagnostic.code)}]`;
      return (
        `${file}:${diagnostic.range.start.line + 1}:` +
        `${diagnostic.range.start.character + 1}: ${level}${code} ${diagnostic.message}`
      );
    })
    .join('\n');
}

/** A position request body, 1-based `line` in, 0-based LSP position out. */
function positionParams(
  file: string,
  line: number | undefined,
  action: string,
): {
  textDocument: { uri: string };
  position: { line: number; character: number };
} {
  if (line === undefined) {
    throw new Error(
      `action "${action}" requires a 1-based \`line\` naming the position`,
    );
  }
  return {
    textDocument: { uri: fileToUri(file) },
    position: { line: line - 1, character: 0 },
  };
}

function serverSupportsFile(server: ServerConfig, file: string): boolean {
  const lower = file.toLowerCase();
  return (server.fileTypes ?? []).some((type) =>
    lower.endsWith(type.toLowerCase()),
  );
}

abstract class BaseLspInvocation extends BaseToolInvocation<
  LspToolParams,
  ToolResult
> {
  constructor(
    protected readonly config: Config,
    params: LspToolParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
  }

  override getDescription(): string {
    const where =
      this.params.file === undefined ? '' : ` on ${this.params.file}`;
    return `${this.params.action}${where}`;
  }

  override toolLocations(): ToolLocation[] {
    return this.params.file
      ? [{ path: this.params.file, line: this.params.line }]
      : [];
  }

  override getPolicyUpdateOptions(
    _outcome: ToolConfirmationOutcome,
  ): PolicyUpdateOptions | undefined {
    if (!this.params.file) return undefined;
    return { argsPattern: `"file"\\s*:\\s*"${this.params.file}"` };
  }

  protected targetDir(): string {
    return this.config.getTargetDir();
  }

  protected timeoutMs(): number {
    return (this.params.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  protected requireFile(): string {
    const file = this.params.file;
    if (file === undefined || file === '') {
      throw new Error(`action "${this.params.action}" requires a \`file\``);
    }
    return file;
  }

  protected detectedServers(): ServerConfig[] {
    const config = loadLspConfig(this.targetDir());
    return Object.values(detectServers(config.servers, this.targetDir()));
  }

  protected serversForFile(file: string): ServerConfig[] {
    return this.detectedServers().filter((server) =>
      serverSupportsFile(server, file),
    );
  }

  protected primaryServerFor(file: string): ServerConfig {
    const server = matchServerForFile(this.serversForFile(file), file);
    if (server === undefined) {
      throw new Error(
        `No language server is configured for ${file}. Install one ` +
          '(typescript-language-server, pyright, rust-analyzer, gopls, …) ' +
          'or declare it in lsp.json.',
      );
    }
    return server;
  }

  protected async clientFor(server: ServerConfig): Promise<LspClient> {
    return getOrCreateLspClient(server, this.targetDir());
  }

  protected text(body: string): ToolResult {
    return { llmContent: body, returnDisplay: body };
  }

  protected failure(message: string): ToolResult {
    return {
      llmContent: message,
      returnDisplay: message,
      error: { message, type: ToolErrorType.LSP_REQUEST_FAILED },
    };
  }

  protected async reportStatus(): Promise<ToolResult> {
    const detected = this.detectedServers();
    if (detected.length === 0) {
      return this.text(
        'No language servers are configured for this project.\n' +
          'Add one to lsp.json, or install a server whose root marker matches this directory.',
      );
    }
    const live = getActiveLspClients();
    const lines = detected.map((server) => {
      const running = live.find((entry) => entry.name === server.command);
      return `${server.command}: ${
        running ? `running (${running.status})` : 'configured, not started'
      }`;
    });
    return this.text(
      `Detected ${detected.length} language server(s):\n${lines.join('\n')}`,
    );
  }

  protected async reportCapabilities(): Promise<ToolResult> {
    const servers = this.serversForFile(this.requireFile());
    if (servers.length === 0) {
      throw new Error(
        `No language server is configured for ${this.params.file}`,
      );
    }
    const parts: string[] = [];
    for (const server of servers) {
      const client = await this.clientFor(server);
      const capabilities = client.getServerCapabilities();
      parts.push(
        `## ${server.command}\n` +
          (capabilities
            ? JSON.stringify(capabilities, null, 2)
            : '(server has not reported capabilities yet)'),
      );
    }
    return this.text(parts.join('\n\n'));
  }

  protected async reloadServers(): Promise<ToolResult> {
    const servers = this.params.file
      ? this.serversForFile(this.params.file)
      : this.detectedServers();
    const notes: string[] = [];
    for (const server of servers) {
      clearInitializationFailure(server, this.targetDir());
      const client = await this.clientFor(server);
      try {
        await client.request(
          'workspace/didChangeConfiguration',
          reloadConfigurationParams(server),
          { timeoutMs: this.timeoutMs() },
        );
        notes.push(`${server.command}: reloaded`);
      } catch (err) {
        // rust-analyzer answers a dedicated reload request; everything else
        // takes the generic configuration notification. A server that supports
        // neither is reported, not fatal.
        notes.push(`${server.command}: ${getErrorMessage(err)}`);
      }
    }
    return this.text(
      notes.length === 0 ? 'Nothing to reload.' : notes.join('\n'),
    );
  }

  protected async rawRequest(signal?: AbortSignal): Promise<ToolResult> {
    const method = this.params.query;
    if (method === undefined || method === '') {
      throw new Error(
        'action "request" requires `query` to name the LSP method',
      );
    }
    const servers = this.params.file
      ? this.serversForFile(this.params.file)
      : this.detectedServers();
    const server = servers[0];
    if (server === undefined) {
      throw new Error('No language server is configured for this project');
    }
    const client = await this.clientFor(server);
    const result: unknown = await client.request(
      method,
      this.rawRequestParams(),
      { timeoutMs: this.timeoutMs(), signal },
    );
    return this.text(JSON.stringify(result ?? null, null, 2));
  }

  private rawRequestParams(): unknown {
    if (this.params.payload !== undefined) return this.params.payload;
    const file = this.params.file;
    if (file === undefined) return {};
    if (this.params.line === undefined) {
      return { textDocument: { uri: fileToUri(file) } };
    }
    return positionParams(file, this.params.line, 'request');
  }
}

class LspReadInvocation extends BaseLspInvocation {
  override async execute(options: ExecuteOptions): Promise<ToolResult> {
    const { action } = this.params;
    try {
      switch (action) {
        case 'status':
          return await this.reportStatus();
        case 'capabilities':
          return await this.reportCapabilities();
        case 'reload':
          return await this.reloadServers();
        case 'request':
          return await this.rawRequest(options.abortSignal);
        case 'diagnostics':
          if (this.params.file === '*') {
            return await this.workspaceDiagnostics(options.abortSignal);
          }
          return await this.fileDiagnostics(
            this.requireFile(),
            options.abortSignal,
          );
        case 'definition':
        case 'type_definition':
        case 'implementation':
          return await this.positionQuery(action);
        case 'references':
          return await this.referencesQuery();
        case 'hover':
          return await this.hoverQuery();
        case 'symbols':
          if (this.params.file === '*') {
            return await this.workspaceSymbols();
          }
          return await this.documentSymbols();
        default:
          return this.failure(
            `Unknown lsp action "${action}". Valid actions: ${READ_ACTIONS.join(', ')}.`,
          );
      }
    } catch (err) {
      return this.failure(getErrorMessage(err));
    }
  }

  private async fileDiagnostics(
    file: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const client = await this.clientFor(this.primaryServerFor(file));
    await client.ensureFileOpen(file);
    const diagnostics = await waitForDiagnostics(client, file, {
      timeoutMs: this.timeoutMs(),
      signal,
    });
    return this.text(formatDiagnostics(file, diagnostics));
  }

  private async workspaceDiagnostics(
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const result = await runWorkspaceDiagnostics(this.targetDir(), {
      signal,
      timeoutMs: this.timeoutMs(),
    });
    if (result.diagnostics.length === 0) {
      return this.text(
        result.ok
          ? `${result.detected}: OK — no errors.`
          : `${result.detected}: ${result.output}`,
      );
    }
    return this.text(
      result.diagnostics
        .map(
          (d) =>
            `${d.file ?? '<workspace>'}:${d.line ?? 1}: ${d.severity} ${d.message}`,
        )
        .join('\n'),
    );
  }

  private async positionQuery(action: string): Promise<ToolResult> {
    const file = this.requireFile();
    const client = await this.clientFor(this.primaryServerFor(file));
    await client.ensureFileOpen(file);
    const method =
      action === 'definition'
        ? 'textDocument/definition'
        : action === 'type_definition'
          ? 'textDocument/typeDefinition'
          : 'textDocument/implementation';
    const result: unknown = await client.request(
      method,
      positionParams(file, this.params.line, action),
      { timeoutMs: this.timeoutMs() },
    );
    return this.text(renderLocations(result, file));
  }

  private async referencesQuery(): Promise<ToolResult> {
    const file = this.requireFile();
    const client = await this.clientFor(this.primaryServerFor(file));
    await client.ensureFileOpen(file);
    const result: unknown = await client.request(
      'textDocument/references',
      {
        ...positionParams(file, this.params.line, 'references'),
        context: { includeDeclaration: true },
      },
      { timeoutMs: this.timeoutMs() },
    );
    return this.text(renderLocations(result, file));
  }

  private async hoverQuery(): Promise<ToolResult> {
    const file = this.requireFile();
    const client = await this.clientFor(this.primaryServerFor(file));
    await client.ensureFileOpen(file);
    const result: unknown = await client.request(
      'textDocument/hover',
      positionParams(file, this.params.line, 'hover'),
      { timeoutMs: this.timeoutMs() },
    );
    return this.text(renderHover(result));
  }

  private async documentSymbols(): Promise<ToolResult> {
    const file = this.requireFile();
    const client = await this.clientFor(this.primaryServerFor(file));
    await client.ensureFileOpen(file);
    const result: unknown = await client.request(
      'textDocument/documentSymbol',
      { textDocument: { uri: fileToUri(file) } },
      { timeoutMs: this.timeoutMs() },
    );
    return this.text(JSON.stringify(result ?? [], null, 2));
  }

  private async workspaceSymbols(): Promise<ToolResult> {
    // A linter knows no symbols; asking one produces noise, not answers.
    const servers = this.detectedServers().filter((s) => !s.isLinter);
    if (servers.length === 0) {
      return this.failure('No project-aware language server is configured.');
    }
    const query = this.params.query ?? this.params.symbol ?? '';
    const lines: string[] = [];
    for (const server of servers) {
      const client = await this.clientFor(server);
      const result: unknown = await client.request(
        'workspace/symbol',
        { query },
        { timeoutMs: this.timeoutMs() },
      );
      if (!Array.isArray(result)) continue;
      for (const entry of result) {
        if (
          typeof entry === 'object' &&
          entry !== null &&
          'name' in entry &&
          'location' in entry &&
          isLocation(entry.location)
        ) {
          lines.push(
            `${String(entry.name)} — ${uriToFile(entry.location.uri)}:${entry.location.range.start.line + 1}`,
          );
        }
      }
    }
    return this.text(
      lines.length === 0
        ? `No workspace symbols matched "${query}".`
        : lines.slice(0, 200).join('\n'),
    );
  }
}

class LspEditInvocation extends BaseLspInvocation {
  override async execute(options: ExecuteOptions): Promise<ToolResult> {
    const { action, apply, new_name, query } = this.params;
    try {
      switch (action) {
        case 'rename':
          return await this.renameSymbol(apply !== false, options.abortSignal);
        case 'rename_file':
          return await this.renameFile(new_name, options.abortSignal);
        case 'code_actions':
          return await this.codeActions(
            query,
            apply === true,
            options.abortSignal,
          );
        default:
          return this.failure(
            `Unknown lsp write action "${action}". Valid actions: ${WRITE_ACTIONS.join(', ')}.`,
          );
      }
    } catch (err) {
      return this.failure(getErrorMessage(err));
    }
  }

  private async renameSymbol(
    shouldApply: boolean,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const file = this.requireFile();
    const newName = this.params.new_name;
    if (newName === undefined || newName === '') {
      return this.failure('action "rename" requires `new_name`');
    }
    const client = await this.clientFor(this.primaryServerFor(file));
    await client.ensureFileOpen(file);
    const edit: unknown = await client.request(
      'textDocument/rename',
      {
        ...positionParams(file, this.params.line, 'rename'),
        newName,
      },
      { timeoutMs: this.timeoutMs(), signal },
    );
    if (!isWorkspaceEdit(edit)) {
      return this.failure(
        'The server returned no workspace edit; nothing was changed.',
      );
    }
    const result = await applyWorkspaceEditToDisk(edit, {
      cwd: this.targetDir(),
    });
    return this.text(
      result.applied.length === 0
        ? 'The workspace edit was empty; nothing was changed.'
        : `Renamed to ${newName}. Updated:\n${result.applied.join('\n')}`,
    );
  }

  private async renameFile(
    destination: string | undefined,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const file = this.requireFile();
    if (destination === undefined || destination === '') {
      return this.failure('action "rename_file" requires `new_name`');
    }
    const servers = this.serversForFile(file).filter((s) => !s.isLinter);
    if (servers.length === 0) {
      return this.failure(
        `No language server is configured for ${file}; refusing to move it, ` +
          'because references would be left pointing at the old path.',
      );
    }
    const [server] = servers;
    if (server === undefined) {
      return this.failure(`No language server is configured for ${file}.`);
    }
    const client = await this.clientFor(server);
    // `applyEditsThenRename` consults `workspace/willRenameFiles` first and
    // aborts the whole move if a supporting server errors, so no file is ever
    // left with dangling references.
    const result = await applyEditsThenRename(
      client,
      [] as RenameReferenceEdit[],
      file,
      destination,
      {
        signal,
      },
    );
    return this.text(
      `Renamed ${file} to ${destination}. ` +
        `${result.editedUris.length} reference file(s) updated` +
        `${result.consultedServer ? ' (via workspace/willRenameFiles)' : ''}. ` +
        'Re-run `lsp diagnostics` to verify.',
    );
  }

  private async codeActions(
    selector: string | undefined,
    shouldApply: boolean,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const file = this.requireFile();
    const client = await this.clientFor(this.primaryServerFor(file));
    await client.ensureFileOpen(file);
    const line = this.params.line ?? 1;
    const result: unknown = await client.request(
      'textDocument/codeAction',
      {
        textDocument: { uri: fileToUri(file) },
        range: {
          start: { line: line - 1, character: 0 },
          end: { line: line - 1, character: 0 },
        },
        context: { diagnostics: [], only: selector },
      },
      { timeoutMs: this.timeoutMs(), signal },
    );
    const titles = codeActionTitles(result);
    if (!shouldApply) {
      return this.text(
        titles.length === 0
          ? 'No code actions available at that position.'
          : `${titles.length} code action(s):\n${titles
              .map((title, index) => `${index}: ${title}`)
              .join('\n')}`,
      );
    }
    const chosen = selectCodeAction(result, selector);
    if (chosen === undefined) {
      return this.failure(
        `No code action matched ${JSON.stringify(selector ?? '')}. ` +
          'Re-run with `apply` omitted to list them.',
      );
    }
    const edit = chosen.edit;
    if (!isWorkspaceEdit(edit)) {
      return this.failure(
        `"${chosen.title}" carries a command, not a workspace edit. ` +
          'Run it yourself with run_shell_command.',
      );
    }
    const applied = await applyWorkspaceEditToDisk(edit, {
      cwd: this.targetDir(),
    });
    return this.text(
      `Applied "${chosen.title}":\n${applied.applied.join('\n')}`,
    );
  }
}

function isWorkspaceEdit(value: unknown): value is WorkspaceEdit {
  if (typeof value !== 'object' || value === null) return false;
  if ('changes' in value) return true;
  return 'documentChanges' in value;
}

interface CodeActionChoice {
  title: string;
  edit?: WorkspaceEdit;
}

function codeActionChoices(result: unknown): CodeActionChoice[] {
  if (!Array.isArray(result)) return [];
  const choices: CodeActionChoice[] = [];
  for (const entry of result) {
    if (typeof entry !== 'object' || entry === null || !('title' in entry)) {
      continue;
    }
    const edit: unknown = 'edit' in entry ? entry.edit : undefined;
    const choice: CodeActionChoice = { title: String(entry.title) };
    if (isWorkspaceEdit(edit)) choice.edit = edit;
    choices.push(choice);
  }
  return choices;
}

function codeActionTitles(result: unknown): string[] {
  return codeActionChoices(result).map((choice) => choice.title);
}

/**
 * Resolve a code action by 0-based index or case-insensitive title substring.
 * An explicit request that matches nothing is an error, never a silent
 * no-op: the model must know its selector was wrong.
 */
function selectCodeAction(
  result: unknown,
  selector: string | undefined,
): CodeActionChoice | undefined {
  const choices = codeActionChoices(result);
  if (choices.length === 0) return undefined;
  if (selector === undefined || selector === '') return choices[0];
  const asIndex = Number.parseInt(selector, 10);
  if (
    String(asIndex) === selector &&
    asIndex >= 0 &&
    asIndex < choices.length
  ) {
    return choices[asIndex];
  }
  const needle = selector.toLowerCase();
  return choices.find((choice) => choice.title.toLowerCase().includes(needle));
}

function renderHover(result: unknown): string {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('contents' in result)
  ) {
    return 'No hover information.';
  }
  const contents = result.contents;
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (typeof entry === 'object' && entry !== null && 'value' in entry) {
          const value: unknown = entry.value;
          return typeof value === 'string' ? value : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(contents, null, 2);
}

/** Read-only LSP queries: safe to run in parallel and in plan mode. */
export class LspTool extends BaseDeclarativeTool<LspToolParams, ToolResult> {
  static readonly Name = LSP_TOOL_NAME;
  constructor(
    private config: Config,
    messageBus: MessageBus,
  ) {
    super(
      LspTool.Name,
      LSP_DISPLAY_NAME,
      LSP_DEFINITION.base.description!,
      Kind.Search,
      LSP_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(
    params: LspToolParams,
  ): string | null {
    if (!params.action) return 'The `action` parameter is required.';
    if (!READ_ACTIONS.includes(params.action)) {
      return (
        `"${params.action}" is not a read action. Use the lsp edit tool ` +
        `for ${WRITE_ACTIONS.join(', ')}.`
      );
    }
    if (params.timeout !== undefined && params.timeout < 5) {
      return 'timeout must be at least 5 seconds.';
    }
    return null;
  }

  protected createInvocation(
    params: LspToolParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<LspToolParams, ToolResult> {
    return new LspReadInvocation(
      this.config,
      params,
      messageBus,
      toolName ?? this.name,
      toolDisplayName ?? this.displayName,
    );
  }
}

/** Mutating LSP actions: rename, rename_file, code_actions. */
export class LspEditTool extends BaseDeclarativeTool<
  LspToolParams,
  ToolResult
> {
  static readonly Name = `${LSP_TOOL_NAME}_edit`;
  constructor(
    private config: Config,
    messageBus: MessageBus,
  ) {
    super(
      LspEditTool.Name,
      `${LSP_DISPLAY_NAME} (write)`,
      'Applies language-server edits: rename a symbol, rename a file, or list and run code actions. These change files on disk, so every call is confirmed first.',
      Kind.Edit,
      LSP_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(
    params: LspToolParams,
  ): string | null {
    if (!params.action) return 'The `action` parameter is required.';
    if (!WRITE_ACTIONS.includes(params.action)) {
      return (
        `"${params.action}" is not a write action. Use the read-only lsp ` +
        'tool for queries.'
      );
    }
    return null;
  }

  protected createInvocation(
    params: LspToolParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<LspToolParams, ToolResult> {
    return new LspEditInvocation(
      this.config,
      params,
      messageBus,
      toolName ?? this.name,
      toolDisplayName ?? this.displayName,
    );
  }
}
