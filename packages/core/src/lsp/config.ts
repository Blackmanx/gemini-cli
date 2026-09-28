/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import DEFAULTS_JSON from './defaults.json' with { type: 'json' };
import type { ServerCapabilities, ServerConfig } from './types.js';
import { isRecord } from '../utils/markdownUtils.js';

/** Shape of an on-disk `lsp.json` / `lsp.yaml` config file. */
export interface LspConfigFile {
  servers?: Record<string, ServerConfig>;
  /** Idle timeout in ms; clients are shut down after this much inactivity. */
  idleTimeoutMs?: number;
}

/** Fully resolved config for a target directory. */
export interface ResolvedLspConfig {
  servers: Record<string, ServerConfig>;
  idleTimeoutMs: number;
  warnings: string[];
}

/** Idle timeout used when no config file sets one: clients are never reaped. */
export const DEFAULT_IDLE_TIMEOUT_MS = 0;

/**
 * Actions that do not mutate the workspace or language-server state. Anything
 * absent (rename, code_actions with apply, rename_file, reload, raw request)
 * is write-tier.
 */
export const LSP_READONLY_ACTIONS: ReadonlySet<string> = new Set([
  'diagnostics',
  'definition',
  'type_definition',
  'implementation',
  'references',
  'hover',
  'symbols',
  'status',
  'capabilities',
]);

/** Substituted with the host PID so servers can supervise the client. */
const PID_TOKEN = '$PID';

type RawServerConfig = Partial<ServerConfig> & {
  /** Legacy alias: map of extension → language id. */
  extensionToLanguage?: unknown;
  /** Legacy alias for `initOptions`. */
  initializationOptions?: unknown;
};

interface NormalizedConfig {
  servers: Record<string, RawServerConfig>;
  idleTimeoutMs?: number;
}

function parseConfigContent(content: string, filePath: string): unknown {
  const extension = path.extname(filePath).toLowerCase();
  // `js-yaml` is already a runtime dependency of @google/gemini-cli-core, so
  // `.yaml`/`.yml` config files are accepted alongside JSON. If a YAML parser
  // is ever dropped, this branch must be removed rather than silently
  // mis-parsing YAML as JSON.
  if (extension === '.yaml' || extension === '.yml') {
    return loadYaml(content);
  }
  return JSON.parse(content) as unknown;
}

function normalizeConfig(value: unknown): NormalizedConfig | null {
  if (!isRecord(value)) return null;

  const rawIdleTimeoutMs = value['idleTimeoutMs'];
  const idleTimeoutMs =
    typeof rawIdleTimeoutMs === 'number' ? rawIdleTimeoutMs : undefined;
  const rawServers = value['servers'];

  if (isRecord(rawServers)) {
    return { servers: copyServerEntries(rawServers, null), idleTimeoutMs };
  }

  // Bare-map form: every top-level key except idleTimeoutMs is a server.
  return { servers: copyServerEntries(value, 'idleTimeoutMs'), idleTimeoutMs };
}

/**
 * Copy the record-shaped entries of an untrusted config map. Every field is
 * re-validated by `normalizeServerConfig`, so the copy only has to prove that
 * each entry is an object at all.
 */
function copyServerEntries(
  value: Record<string, unknown>,
  skipKey: string | null,
): Record<string, RawServerConfig> {
  const servers: Record<string, RawServerConfig> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === skipKey) continue;
    if (isRecord(entry)) servers[key] = entry;
  }
  return servers;
}

function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
  return items.length > 0 ? items : null;
}

function normalizeExtensionToFileTypes(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  const extensions = Object.keys(value).filter(
    (extension) => extension.length > 0,
  );
  return extensions.length > 0 ? extensions : null;
}

function normalizeServerConfig(
  name: string,
  config: RawServerConfig,
  warnings: string[],
): ServerConfig | null {
  const command =
    typeof config.command === 'string' && config.command.length > 0
      ? config.command
      : null;
  const fileTypes =
    normalizeStringArray(config.fileTypes) ??
    normalizeExtensionToFileTypes(config.extensionToLanguage);
  const rootMarkers =
    normalizeStringArray(config.rootMarkers) ??
    (config.extensionToLanguage ? ['.'] : null);
  const languageId =
    typeof config.languageId === 'string' && config.languageId.length > 0
      ? config.languageId
      : undefined;

  if (!command || !fileTypes || !rootMarkers) {
    warnings.push(
      `Ignoring invalid LSP server config "${name}" (requires command, fileTypes, rootMarkers).`,
    );
    return null;
  }

  const args = Array.isArray(config.args)
    ? config.args.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const initOptions = isRecord(config.initOptions)
    ? config.initOptions
    : isRecord(config.initializationOptions)
      ? config.initializationOptions
      : undefined;

  return {
    ...config,
    command,
    args,
    fileTypes,
    rootMarkers,
    languageId,
    ...(initOptions ? { initOptions } : {}),
  };
}

function mergeServers(
  base: Record<string, ServerConfig>,
  overrides: Record<string, RawServerConfig>,
  warnings: string[],
): Record<string, ServerConfig> {
  const merged: Record<string, ServerConfig> = { ...base };
  for (const [name, override] of Object.entries(overrides)) {
    const existing = merged[name];
    const normalized = normalizeServerConfig(
      name,
      existing ? { ...existing, ...override } : override,
      warnings,
    );
    if (!normalized) continue;
    merged[name] = normalized;
  }
  return merged;
}

function substitutePid(servers: Record<string, ServerConfig>): void {
  const omnisharp = servers['omnisharp'];
  if (!omnisharp?.args?.includes(PID_TOKEN)) return;
  servers['omnisharp'] = {
    ...omnisharp,
    args: omnisharp.args.map((arg) =>
      arg === PID_TOKEN ? String(process.pid) : arg,
    ),
  };
}

// =============================================================================
// Root Markers
// =============================================================================

const GLOB_META = /[.+^${}()|[\]\\]/g;

/**
 * Translate a one-level glob (`*.cabal`, `CMake*.txt`) to an anchored RegExp.
 * `**` collapses to `*` because root markers are only ever checked against the
 * target directory's own entries — no ancestor walk, no recursion.
 */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      // Collapse runs of '*' (including '**') into a single wildcard.
      while (pattern[i + 1] === '*') i++;
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        source += '\\[';
      } else {
        let body = pattern.slice(i + 1, close);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        source += `[${body}]`;
        i = close;
      }
    } else {
      source += char.replace(GLOB_META, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * True when any marker exists in `targetDir`. Glob markers are matched against a
 * single `readdir` of the target directory — never against ancestors.
 */
export function hasRootMarkers(
  targetDir: string,
  markers: readonly string[],
): boolean {
  let entries: string[] | null = null;
  for (const marker of markers) {
    if (marker === '.') return true;
    if (marker.includes('*') || marker.includes('?') || marker.includes('[')) {
      if (entries === null) {
        try {
          entries = fs.readdirSync(targetDir);
        } catch {
          entries = [];
        }
      }
      const glob = globToRegExp(marker);
      for (const entry of entries) {
        if (glob.test(entry)) return true;
      }
      continue;
    }
    try {
      fs.accessSync(path.join(targetDir, marker));
      return true;
    } catch {
      // Marker absent; try the next one.
    }
  }
  return false;
}

// =============================================================================
// Executable Resolution
// =============================================================================

/** Root markers that gate each project-local bin directory, highest priority first. */
const PYTHON_ROOT_MARKERS = [
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'pyrightconfig.json',
];

const LOCAL_BIN_PATHS: ReadonlyArray<{
  markers: readonly string[];
  binDir: string;
}> = [
  // Node.js: npm/yarn/pnpm write launchers into node_modules/.bin.
  {
    markers: [
      'package.json',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
    ],
    binDir: 'node_modules/.bin',
  },
  // Python virtual environments.
  { markers: PYTHON_ROOT_MARKERS, binDir: '.venv/bin' },
  { markers: PYTHON_ROOT_MARKERS, binDir: '.venv/Scripts' },
  { markers: PYTHON_ROOT_MARKERS, binDir: 'venv/bin' },
  { markers: PYTHON_ROOT_MARKERS, binDir: 'venv/Scripts' },
  { markers: PYTHON_ROOT_MARKERS, binDir: '.env/bin' },
  { markers: PYTHON_ROOT_MARKERS, binDir: '.env/Scripts' },
  // Ruby bundler binstubs.
  { markers: ['Gemfile', 'Gemfile.lock'], binDir: 'vendor/bundle/bin' },
  { markers: ['Gemfile', 'Gemfile.lock'], binDir: 'bin' },
  // Go tool installs.
  { markers: ['go.mod', 'go.sum', 'go.work'], binDir: 'bin' },
];

const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat'] as const;

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveLocalCandidate(basePath: string): string | null {
  if (isExecutableFile(basePath)) return basePath;
  if (process.platform !== 'win32') return null;
  for (const extension of WINDOWS_EXECUTABLE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function resolveFromPath(
  command: string,
  pathEnv: string | undefined,
): string | null {
  if (!pathEnv) return null;
  const extensions =
    process.platform === 'win32'
      ? [...WINDOWS_EXECUTABLE_EXTENSIONS, '']
      : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve a command to an absolute executable path.
 *
 * Project-local bin directories (`node_modules/.bin`, venv `bin/`, …) are tried
 * BEFORE `$PATH`, so a project-pinned server wins over a global one. Never
 * shells out to `which`.
 *
 * @returns The absolute path, or `null` when the command cannot be found.
 */
export function resolveExecutable(
  command: string,
  targetDir: string,
): string | null {
  if (command.includes('/') || command.includes('\\')) {
    return resolveLocalCandidate(path.resolve(targetDir, command));
  }
  for (const { markers, binDir } of LOCAL_BIN_PATHS) {
    if (!hasRootMarkers(targetDir, markers)) continue;
    const resolved = resolveLocalCandidate(
      path.join(targetDir, binDir, command),
    );
    if (resolved) return resolved;
  }
  return resolveFromPath(command, process.env['PATH']);
}

// =============================================================================
// Configuration Loading
// =============================================================================

/** Filenames probed at every config location, in priority order. */
const CONFIG_FILENAMES = [
  'lsp.json',
  '.lsp.json',
  'lsp.yaml',
  '.lsp.yaml',
  'lsp.yml',
  '.lsp.yml',
] as const;

/**
 * Config locations, lowest priority first:
 * 1. `~/lsp.*`, `~/.lsp.*`
 * 2. `~/.gemini/lsp.*` and every `extraDirs` entry
 * 3. `<targetDir>/.gemini/lsp.*`
 * 4. `<targetDir>/lsp.*`, `<targetDir>/.lsp.*`
 */
function configPaths(
  targetDir: string,
  extraDirs: readonly string[],
): string[] {
  const dirs = [
    os.homedir(),
    path.join(os.homedir(), '.gemini'),
    ...extraDirs,
    path.join(targetDir, '.gemini'),
    targetDir,
  ];
  const paths: string[] = [];
  for (const dir of dirs) {
    for (const filename of CONFIG_FILENAMES) {
      paths.push(path.join(dir, filename));
    }
  }
  return paths;
}

function readConfigFile(
  filePath: string,
  warnings: string[],
): NormalizedConfig | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseConfigContent(content, filePath);
  } catch (error) {
    warnings.push(
      `Failed to parse LSP config ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  return normalizeConfig(parsed);
}

/**
 * Fingerprint every config path so a cached result is dropped as soon as any of
 * those files appears, is edited, or is deleted.
 */
function configSignature(paths: readonly string[]): string {
  const parts: string[] = [];
  for (const filePath of paths) {
    try {
      const stat = fs.statSync(filePath);
      parts.push(`${filePath}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      // Missing files still occupy a slot so creating one changes the signature.
      parts.push(`${filePath}:-`);
    }
  }
  return parts.join('|');
}

interface CacheEntry {
  signature: string;
  config: ResolvedLspConfig;
}

const configCache = new Map<string, CacheEntry>();

/** Drop every cached config; the next {@link loadLspConfig} re-reads from disk. */
export function clearLspConfigCache(): void {
  configCache.clear();
}

/**
 * Load the LSP configuration for `targetDir`.
 *
 * Config files are merged from lowest to highest priority, so the project's own
 * `lsp.json` overrides the built-in table and the user-level files. Results are
 * cached per target directory and invalidated when any probed config file's
 * mtime/size changes.
 */
export function loadLspConfig(
  targetDir: string,
  opts?: { extraDirs?: string[] },
): ResolvedLspConfig {
  const resolvedTarget = path.resolve(targetDir);
  const extraDirs = (opts?.extraDirs ?? []).map((dir) => path.resolve(dir));
  const paths = configPaths(resolvedTarget, extraDirs);
  const signature = configSignature(paths);

  const cached = configCache.get(resolvedTarget);
  if (cached && cached.signature === signature) {
    return cached.config;
  }

  const warnings: string[] = [];
  let servers: Record<string, ServerConfig> = {};
  let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

  // Lowest priority first; later files override earlier ones.
  for (const filePath of paths) {
    const parsed = readConfigFile(filePath, warnings);
    if (!parsed) continue;
    servers = mergeServers(servers, parsed.servers, warnings);
    if (parsed.idleTimeoutMs !== undefined)
      idleTimeoutMs = parsed.idleTimeoutMs;
  }

  const builtins: Record<string, RawServerConfig> = {};
  for (const [name, entry] of Object.entries(DEFAULTS_JSON)) {
    builtins[name] = entry as RawServerConfig;
  }
  servers = mergeServers(servers, builtins, warnings);
  substitutePid(servers);

  const config: ResolvedLspConfig = {
    servers: detectServers(servers, resolvedTarget),
    idleTimeoutMs,
    warnings,
  };
  configCache.set(resolvedTarget, { signature, config });
  return config;
}

/**
 * Filter the server table down to the servers usable in `targetDir`: not
 * explicitly disabled, a root marker present in the target directory itself,
 * and a binary that resolves locally or on `$PATH`.
 */
export function detectServers(
  servers: Record<string, ServerConfig>,
  targetDir: string,
): Record<string, ServerConfig> {
  const detected: Record<string, ServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (config.disabled) continue;
    if (
      config.rootMarkers.length > 0 &&
      !hasRootMarkers(targetDir, config.rootMarkers)
    ) {
      continue;
    }
    const resolved =
      config.resolvedCommand ?? resolveExecutable(config.command, targetDir);
    if (!resolved) continue;
    detected[name] = { ...config, resolvedCommand: resolved };
  }
  return detected;
}

// =============================================================================
// Server Selection
// =============================================================================

function serverSupportsFile(config: ServerConfig, filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const extNoDot = ext.startsWith('.') ? ext.slice(1) : ext;
  const fileName = path.basename(filePath).toLowerCase();
  return config.fileTypes.some((fileType) => {
    // Accept both `.ts` and `ts` forms so a missing dot in `fileTypes` cannot
    // silently exclude a server from extension routing.
    const normalized = fileType.toLowerCase();
    const normalizedNoDot = normalized.startsWith('.')
      ? normalized.slice(1)
      : normalized;
    return (
      normalized === ext ||
      normalized === fileName ||
      normalizedNoDot === extNoDot ||
      normalizedNoDot === fileName
    );
  });
}

/**
 * Every server claiming `filePath`, type-checkers first and linters last, so
 * callers can pick the strongest provider for a given operation tier.
 */
export function getServersForFile(
  servers: Record<string, ServerConfig>,
  filePath: string,
): Array<[string, ServerConfig]> {
  const matches: Array<[string, ServerConfig]> = [];
  for (const [name, config] of Object.entries(servers)) {
    if (serverSupportsFile(config, filePath)) matches.push([name, config]);
  }
  return matches.sort(
    (a, b) => Number(!!a[1].isLinter) - Number(!!b[1].isLinter),
  );
}

/**
 * The primary server for a file — prefers type intelligence over linters.
 * Use for definition, hover, references, and rename.
 */
export function matchServerForFile(
  servers: readonly ServerConfig[] | Record<string, ServerConfig>,
  filePath: string,
): ServerConfig | undefined {
  const entries: Array<[string, ServerConfig]> = [];
  if (isServerConfigList(servers)) {
    for (const config of servers) entries.push([config.command, config]);
  } else {
    for (const [name, config] of Object.entries(servers))
      entries.push([name, config]);
  }
  return getServersForFile(Object.fromEntries(entries), filePath)[0]?.[1];
}

/** Distinguishes the list form from the name→config map form. */
function isServerConfigList(
  servers: readonly ServerConfig[] | Record<string, ServerConfig>,
): servers is readonly ServerConfig[] {
  return Array.isArray(servers);
}

/** True when the config declares a server-side capability. */
export function hasCapability(
  config: ServerConfig,
  capability: keyof ServerCapabilities,
): boolean {
  return config.capabilities?.[capability] === true;
}

/** True when a server provides project-wide type intelligence (not a linter). */
export function isProjectAwareLspServer(config: ServerConfig): boolean {
  return !config.isLinter;
}

/** True when an LSP error means "this server does not implement the method". */
export function isMethodNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('method not found') ||
    message.includes('unhandled method') ||
    message.includes('not supported') ||
    message.includes('-32601')
  );
}

/** Params for the generic `workspace/didChangeConfiguration` reload. */
export function reloadConfigurationParams(config: ServerConfig): {
  settings: Record<string, unknown>;
} {
  return { settings: config.settings ?? {} };
}
