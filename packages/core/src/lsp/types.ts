/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// =============================================================================
// Actions
// =============================================================================

/** Every action the LSP tool surface can dispatch. */
export type LspAction =
  | 'diagnostics'
  | 'definition'
  | 'type_definition'
  | 'implementation'
  | 'references'
  | 'hover'
  | 'symbols'
  | 'rename'
  | 'rename_file'
  | 'code_actions'
  | 'status'
  | 'reload'
  | 'capabilities'
  | 'request';

/** Runtime list of {@link LspAction} ids, in tool-dispatch order. */
export const LSP_ACTIONS: readonly LspAction[] = [
  'diagnostics',
  'definition',
  'type_definition',
  'implementation',
  'references',
  'hover',
  'symbols',
  'rename',
  'rename_file',
  'code_actions',
  'status',
  'reload',
  'capabilities',
  'request',
] as const;

/** True when `value` is one of the 14 known action ids. */
export function isLspAction(value: string): value is LspAction {
  return (LSP_ACTIONS as readonly string[]).includes(value);
}

// =============================================================================
// Core LSP Protocol Types
// =============================================================================

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  originSelectionRange?: Range;
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}

// =============================================================================
// Diagnostics
// =============================================================================

/** 1 = error, 2 = warning, 3 = info, 4 = hint. */
export type DiagnosticSeverity = 1 | 2 | 3 | 4;

export interface DiagnosticRelatedInformation {
  location: Location;
  message: string;
}

export interface Diagnostic {
  range: Range;
  severity?: DiagnosticSeverity;
  code?: string | number;
  codeDescription?: { href: string };
  source?: string;
  message: string;
  tags?: number[];
  relatedInformation?: DiagnosticRelatedInformation[];
  data?: unknown;
}

export interface PublishedDiagnostics {
  diagnostics: Diagnostic[];
  version: number | null;
}

export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Diagnostic[];
  version?: number | null;
}

/** LSP 3.17 pull-diagnostics report (`kind: 'full'`). */
export interface DocumentDiagnosticReport {
  kind: 'full' | 'unchanged';
  resultId?: string;
  items: Diagnostic[];
}

// =============================================================================
// Text Edits
// =============================================================================

export interface TextEdit {
  range: Range;
  newText: string;
  /** 1 = plain text, 2 = snippet. Snippet edits are rejected by the editor. */
  insertTextFormat?: 1 | 2;
}

export interface AnnotatedTextEdit extends TextEdit {
  annotationId?: string;
}

export interface TextDocumentIdentifier {
  uri: string;
}

export interface VersionedTextDocumentIdentifier
  extends TextDocumentIdentifier {
  version: number | null;
}

export interface OptionalVersionedTextDocumentIdentifier
  extends TextDocumentIdentifier {
  version?: number | null;
}

export interface TextDocumentEdit {
  textDocument: OptionalVersionedTextDocumentIdentifier;
  edits: Array<TextEdit | AnnotatedTextEdit>;
}

// =============================================================================
// Resource Operations
// =============================================================================

export interface CreateFileOptions {
  overwrite?: boolean;
  ignoreIfExists?: boolean;
}

export interface CreateFile {
  kind: 'create';
  uri: string;
  options?: CreateFileOptions;
}

export interface RenameFileOptions {
  overwrite?: boolean;
  ignoreIfExists?: boolean;
}

export interface RenameFile {
  kind: 'rename';
  oldUri: string;
  newUri: string;
  options?: RenameFileOptions;
}

export interface DeleteFileOptions {
  recursive?: boolean;
  ignoreIfNotExists?: boolean;
}

export interface DeleteFile {
  kind: 'delete';
  uri: string;
  options?: DeleteFileOptions;
}

export type DocumentChange =
  | TextDocumentEdit
  | CreateFile
  | RenameFile
  | DeleteFile;

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: DocumentChange[];
  changeAnnotations?: Record<
    string,
    { label: string; needsConfirmation?: boolean; description?: string }
  >;
}

// =============================================================================
// Code Actions
// =============================================================================

export type CodeActionKind =
  | 'quickfix'
  | 'refactor'
  | 'refactor.extract'
  | 'refactor.inline'
  | 'refactor.rewrite'
  | 'source'
  | 'source.organizeImports'
  | 'source.fixAll'
  | string;

export interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface CodeAction {
  title: string;
  kind?: CodeActionKind;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: WorkspaceEdit;
  command?: Command;
  data?: unknown;
}

export interface CodeActionContext {
  diagnostics: Diagnostic[];
  only?: CodeActionKind[];
  /** 1 = Invoked, 2 = Automatic. */
  triggerKind?: 1 | 2;
}

// =============================================================================
// Symbols
// =============================================================================

export type SymbolKind =
  | 1 // File
  | 2 // Module
  | 3 // Namespace
  | 4 // Package
  | 5 // Class
  | 6 // Method
  | 7 // Property
  | 8 // Field
  | 9 // Constructor
  | 10 // Enum
  | 11 // Interface
  | 12 // Function
  | 13 // Variable
  | 14 // Constant
  | 15 // String
  | 16 // Number
  | 17 // Boolean
  | 18 // Array
  | 19 // Object
  | 20 // Key
  | 21 // Null
  | 22 // EnumMember
  | 23 // Struct
  | 24 // Event
  | 25 // Operator
  | 26; // TypeParameter

export const SYMBOL_KIND_NAMES: Record<SymbolKind, string> = {
  1: 'File',
  2: 'Module',
  3: 'Namespace',
  4: 'Package',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Constructor',
  10: 'Enum',
  11: 'Interface',
  12: 'Function',
  13: 'Variable',
  14: 'Constant',
  15: 'String',
  16: 'Number',
  17: 'Boolean',
  18: 'Array',
  19: 'Object',
  20: 'Key',
  21: 'Null',
  22: 'EnumMember',
  23: 'Struct',
  24: 'Event',
  25: 'Operator',
  26: 'TypeParameter',
};

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: SymbolKind;
  tags?: number[];
  deprecated?: boolean;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: SymbolKind;
  tags?: number[];
  deprecated?: boolean;
  location: Location;
  containerName?: string;
}

// =============================================================================
// Server Capabilities
// =============================================================================

/**
 * Server capabilities.
 *
 * Doubles as (a) the advertised capability object returned by
 * `getServerCapabilities()` and (b) the optional `capabilities` hint block a
 * config file may declare for a server. Unrecognized advertised keys stay
 * reachable through the index signature.
 */
export interface ServerCapabilities {
  flycheck?: boolean;
  ssr?: boolean;
  expandMacro?: boolean;
  runnables?: boolean;
  relatedTests?: boolean;
  textDocumentSync?: number | { openClose?: boolean; change?: number };
  hoverProvider?: boolean;
  definitionProvider?: boolean;
  typeDefinitionProvider?: boolean;
  implementationProvider?: boolean;
  referencesProvider?: boolean;
  documentSymbolProvider?: boolean;
  renameProvider?: boolean;
  codeActionProvider?: boolean | { codeActionKinds?: string[] };
  documentFormattingProvider?: boolean;
  documentRangeFormattingProvider?: boolean;
  documentHighlightProvider?: boolean;
  completionProvider?: unknown;
  signatureHelpProvider?: unknown;
  /** LSP 3.17 pull diagnostics. */
  diagnosticProvider?: unknown;
  workspace?: {
    applyEdit?: boolean;
    workspaceFolders?: boolean;
    fileOperations?: {
      willCreate?: boolean;
      didCreate?: boolean;
      willRename?: boolean;
      didRename?: boolean;
      willDelete?: boolean;
      didDelete?: boolean;
    };
  };
  [capability: string]: unknown;
}

export interface MarkupContent {
  kind: 'plaintext' | 'markdown';
  value: string;
}

export type MarkedString = string | { language: string; value: string };

export interface Hover {
  contents: MarkupContent | MarkedString | MarkedString[];
  range?: Range;
}

// =============================================================================
// Server Configuration
// =============================================================================
//
// The config-declared `capabilities` hint block is a strict subset of
// `ServerCapabilities` above, so it reuses that interface directly.

export interface ServerConfig {
  command: string;
  args?: string[];
  fileTypes: string[];
  /** LSP language identifier sent in didOpen; inferred from the path when omitted. */
  languageId?: string;
  rootMarkers: string[];
  initOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  disabled?: boolean;
  /** Per-server override of the 5s warmup deadline. */
  warmupTimeoutMs?: number;
  /** Tuning seam for rust-analyzer workspace-ready polling. */
  workspaceReadyTimings?: {
    timeoutMs?: number;
    pollMs?: number;
    settleMs?: number;
    statusRequestTimeoutMs?: number;
  };
  capabilities?: ServerCapabilities;
  /**
   * Marks a dedicated linter/formatter server (Biome, ruff, …). Excluded from
   * type intelligence (definition, hover, references) but preferred over
   * type-checkers when picking a formatter.
   */
  isLinter?: boolean;
  /** Resolved absolute path to the command binary, set during config loading. */
  resolvedCommand?: string;
}

// =============================================================================
// JSON-RPC Wire Types
// =============================================================================

export type LspJsonRpcId = number | string;

export interface LspJsonRpcRequest {
  jsonrpc: '2.0';
  id: LspJsonRpcId;
  method: string;
  params?: unknown;
}

export interface LspJsonRpcResponse {
  jsonrpc: '2.0';
  id: LspJsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface LspJsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type LspJsonRpcMessage =
  | LspJsonRpcRequest
  | LspJsonRpcResponse
  | LspJsonRpcNotification;

// =============================================================================
// Client State
// =============================================================================

export interface OpenFile {
  /** Document version last sent to the server; `null` when unversioned. */
  version: number | null;
  languageId: string;
  content: string;
  openedAt: number;
  lastChangeAt: number;
}

export interface PendingRequest {
  /**
   * Declared as a method (not a property) so a `Promise<T>` resolver — which
   * only accepts `T` — stays assignable under strictFunctionTypes.
   */
  resolve(value: unknown): void;
  reject(error: Error): void;
  method: string;
}

export type LspClientStatus = 'connecting' | 'ready' | 'error' | 'stopped';
