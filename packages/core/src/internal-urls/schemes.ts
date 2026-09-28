/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  createInternalUrlRouter,
  internalUrlRouter,
  setInternalUrlRouter,
  type InternalUrlRouter,
} from './router.js';
import type {
  InternalResource,
  InternalUrl,
  ResolveContext,
  SchemeSpec,
  WriteContext,
} from './types.js';

/**
 * The URL schemes gemini-cli exposes to the model.
 *
 * Ported from omp's `internal-urls/*` handlers, but each scheme is backed by a
 * subsystem that already exists here rather than an omp-only one: there is no
 * agent registry, memory bank or GitHub cache to read from, so those schemes
 * are registered later, when the subsystem they wrap actually exists.
 */

/** Roots the `local://` scheme may touch, and their backing directories. */
export interface SchemeHost {
  /** Session-scoped scratch directory backing `local://`. */
  scratchDir?: string;
  /** Harness documentation root backing `omp://`. */
  docsDir?: string;
  /** Directory holding skills, backing `skill://`. */
  skillsDirs?: string[];
  /**
   * Settings documents backing `cfg://`, lowest precedence first. The merged
   * view is what the harness will actually load, so `cfg://` reports the real
   * effective configuration rather than a guess.
   */
  settingsFiles?: () => string[];
}

/** Node's errno-tagged error shape, narrowed without an unchecked assertion. */
function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string'
  );
}

function notFound(url: InternalUrl, what: string): never {
  throw new Error(`${url.href}: ${what} not found`);
}

function readFileOrThrow(file: string, url: InternalUrl, what: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = isErrnoException(err) ? err.code : undefined;
    if (code === 'ENOENT') notFound(url, what);
    if (code === 'EISDIR') notFound(url, `${what} (path is a directory)`);
    throw new Error(`${url.href}: cannot read ${what}: ${String(err)}`);
  }
}

/** Reject any path segment that would escape the backing root. */
function safeJoin(root: string, relative: string, url: InternalUrl): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${url.href}: path escapes its root`);
  }
  return target;
}

/**
 * `local://<path>` — a session-scoped scratch directory the agent can write
 * and re-read without touching the user's workspace.
 */
function localScheme(host: () => SchemeHost): SchemeSpec {
  return {
    scheme: 'local',
    backing: 'file',
    selectors: 'lines',
    immutable: false,
    pathAuthority: true,
    singleSlashAlias: true,
    linkable: true,
    write: {
      via: 'file',
      payload: 'text',
      scope: 'sandbox',
      tier: () => 'write',
    },
    resolve(url: InternalUrl, _context?: ResolveContext): InternalResource {
      const dir = host().scratchDir;
      if (!dir) {
        throw new Error('local:// is unavailable: no scratch directory');
      }
      const file = safeJoin(dir, url.rest, url);
      const stats = fs.statSync(file, { throwIfNoEntry: false });
      if (!stats) notFound(url, 'scratch file');
      if (stats.isDirectory()) {
        return {
          url: url.href,
          content: listDirectory(file),
          contentType: 'text/plain',
          isDirectory: true,
        };
      }
      const content = readFileOrThrow(file, url, 'scratch file');
      return {
        url: url.href,
        content,
        contentType: 'text/plain',
        size: Buffer.byteLength(content),
        sourcePath: file,
      };
    },
    locate(
      url: InternalUrl,
      _context?: ResolveContext,
      options?: { create?: boolean },
    ): string | null {
      const dir = host().scratchDir;
      if (!dir) return null;
      const file = safeJoin(dir, url.rest, url);
      if (fs.existsSync(file)) return file;
      // A write target is created by the caller, not by `locate`; report the
      // path so `writeTarget` can hand it back and the caller mkdir -p it.
      if (options?.create === true) return file;
      return null;
    },
  };
}

function listDirectory(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0) return '(empty directory)';
  return entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort()
    .join('\n');
}

/**
 * `cfg://<path>` — the effective settings document, so the model can read what
 * the harness is actually running with instead of guessing.
 */
function cfgScheme(host: () => SchemeHost): SchemeSpec {
  return {
    scheme: 'cfg',
    backing: 'virtual',
    selectors: 'lines',
    immutable: false,
    write: {
      via: 'handler',
      payload: 'verbatim',
      scope: 'device',
      tier: () => 'write',
    },
    resolve(url: InternalUrl): InternalResource {
      const settings = mergeSettingsFiles(host().settingsFiles?.() ?? []);
      if (url.rest === '' || url.rest === '.') {
        return {
          url: url.href,
          content: settings,
          contentType: 'application/json',
          size: Buffer.byteLength(settings),
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(settings);
      } catch (err) {
        throw new Error(`cfg://: settings are not valid JSON: ${String(err)}`);
      }
      const value = jsonPathValue(parsed, url.rest);
      if (value === undefined) {
        throw new Error(`${url.href}: no such settings key`);
      }
      return {
        url: url.href,
        content:
          typeof value === 'string' ? value : JSON.stringify(value, null, 2),
        contentType:
          typeof value === 'string' ? 'text/plain' : 'application/json',
      };
    },
    applyWrite(url: InternalUrl): never {
      throw new Error(
        `${url.href}: settings are edited in settings.json, not through cfg://`,
      );
    },
  };
}

/**
 * Merge the settings documents the harness loads, lowest precedence first.
 * Objects merge shallowly; anything else is replaced by the higher layer, which
 * is how the CLI's own settings merge behaves.
 */
function mergeSettingsFiles(files: readonly string[]): string {
  const merged: Record<string, unknown> = {};
  let found = false;
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') continue;
      throw new Error(`cfg://: cannot read ${file}: ${String(err)}`);
    }
    if (!isPlainObject(parsed)) continue;
    found = true;
    for (const [key, value] of Object.entries(parsed)) {
      const existing = merged[key];
      if (
        existing !== null &&
        typeof existing === 'object' &&
        !Array.isArray(existing) &&
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        merged[key] = { ...existing, ...value };
        continue;
      }
      merged[key] = value;
    }
  }
  if (!found) return '{}';
  return JSON.stringify(merged, null, 2);
}

/** A JSON object literal, as opposed to an array or a primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Dotted key path with numeric array indices, e.g. `tools.allowed.0`. */
function jsonPathValue(root: unknown, dottedPath: string): unknown {
  let current: unknown = root;
  for (const segment of dottedPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (Number.isNaN(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isPlainObject(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * `omp://<doc>` — the harness's own documentation, so the agent can look up a
 * tool reference without burning a turn guessing at a schema.
 */
function docsScheme(host: () => SchemeHost): SchemeSpec {
  return {
    scheme: 'omp',
    backing: 'file',
    selectors: 'lines',
    immutable: true,
    resolve(url: InternalUrl): InternalResource {
      const dir = host().docsDir;
      if (!dir) {
        throw new Error('omp:// is unavailable: no documentation directory');
      }
      const rest = url.rest === '' ? 'index.md' : url.rest;
      const file = safeJoin(dir, rest, url);
      const stats = fs.statSync(file, { throwIfNoEntry: false });
      if (!stats) notFound(url, 'document');
      if (stats.isDirectory()) {
        return {
          url: url.href,
          content: listDirectory(file),
          contentType: 'text/plain',
          isDirectory: true,
        };
      }
      const content = readFileOrThrow(file, url, 'document');
      return {
        url: url.href,
        content,
        contentType: 'text/markdown',
        size: Buffer.byteLength(content),
        sourcePath: file,
      };
    },
    locate(url: InternalUrl): string | null {
      const dir = host().docsDir;
      if (!dir) return null;
      const rest = url.rest === '' ? 'index.md' : url.rest;
      const file = safeJoin(dir, rest, url);
      return fs.existsSync(file) ? file : null;
    },
  };
}

/** Every scheme gemini-cli registers at startup, in prompt order. */
export function geminiSchemeSpecs(host: () => SchemeHost): SchemeSpec[] {
  return [localScheme(host), cfgScheme(host), docsScheme(host)];
}

/** Build a router carrying gemini-cli's schemes. */
export function createGeminiUrlRouter(
  host: () => SchemeHost,
  extra: readonly SchemeSpec[] = [],
): InternalUrlRouter {
  return createInternalUrlRouter([...geminiSchemeSpecs(host), ...extra]);
}

/**
 * Install the process-wide router. Idempotent: a host that is rebuilt (config
 * reload, extension reload) re-points the existing router rather than
 * swapping it, so URLs already resolved keep working.
 */
export function installInternalUrlRouter(
  host: () => SchemeHost,
  extra: readonly SchemeSpec[] = [],
): void {
  const existing = internalUrlRouter();
  if (existing === undefined) {
    setInternalUrlRouter(createGeminiUrlRouter(host, extra));
    return;
  }
  for (const spec of [...geminiSchemeSpecs(host), ...extra]) {
    existing.register(spec);
  }
}

/** Convenience re-export so callers can construct a bare router in tests. */
export { createInternalUrlRouter };
export type { SchemeSpec, WriteContext };

/**
 * Directory holding the harness's packaged documentation, used as the default
 * backing for `omp://`.
 *
 * Resolved from this module's own location so it works from `dist/`, from the
 * bundle, and from a compiled test. Returns `undefined` when the docs were not
 * packaged, which disables the scheme rather than failing every read.
 */
export function packagedDocsDir(): string | undefined {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    // <pkg>/dist/src/internal-urls -> <pkg>/dist/docs
    path.resolve(here, '..', '..', 'docs'),
    // bundled: <root>/bundle -> <root>/bundle/docs
    path.resolve(here, '..', '..', '..', '..', 'docs'),
    // <root>/docs when running straight from source
    path.resolve(here, '..', '..', '..', '..', '..', 'docs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return undefined;
}
