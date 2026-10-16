/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The searchable file set and its model-facing listing. Files are listed once
 * up front (the cascade judges every candidate by name before reading any), so
 * the tree is a flat list of eligible files rather than a lazily expanded
 * directory graph. Eligibility deny-lists build noise, lockfiles, binaries, and
 * obvious credential material.
 *
 * Ported from oh-my-pi's `tools/jfind/tree.ts`; its native glob walker is
 * replaced with the `glob` package plus the workspace's file exclusions, and
 * its path-tree utility with a local prefix-folded renderer.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { globStream } from 'glob';
import { isNodeError } from '../../utils/errors.js';

/** One eligible file under the search root. */
export interface FileEntry {
  /** Absolute path. */
  path: string;
  /** Root-relative display path with `/` separators. */
  rel: string;
  size: number;
}

/** Validated `jfind` scope: a directory to walk, or one file searched alone. */
export type SearchRoot =
  | { path: string; type: 'directory' }
  | { path: string; type: 'file'; size: number };

/**
 * Resolve a `jfind` scope (empty = `cwd`) to an existing directory or file.
 * @throws {Error} missing path, or neither file nor directory.
 */
export async function resolveSearchRoot(
  input: string,
  cwd: string,
): Promise<SearchRoot> {
  if (input.length === 0) return { path: path.resolve(cwd), type: 'directory' };
  const root = path.resolve(cwd, input);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(root);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`Path not found: ${input}`);
    }
    throw error;
  }
  if (stat.isDirectory()) return { path: root, type: 'directory' };
  if (stat.isFile()) return { path: root, type: 'file', size: stat.size };
  throw new Error(`Path is neither a file nor a directory: ${input}`);
}

const DENY_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'coverage',
  '.idea',
  '.vscode',
  '.gradle',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.parcel-cache',
]);

const DENY_FILES = new Set([
  'Cargo.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'flake.lock',
  '.DS_Store',
  'Thumbs.db',
]);

/** Credential files by exact name. Never listed or read, even when hidden files are included. */
const SECRET_FILES = new Set([
  '.env',
  '.envrc',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.boto',
  '.s3cfg',
  '.dockercfg',
  '.git-credentials',
  '.htpasswd',
  'htpasswd',
  'credentials',
  'credentials.json',
  'client_secret.json',
  'service-account.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

/** Credential files by extension: keys, certificate stores, encrypted vaults, and infrastructure state that embeds secrets. */
const SECRET_EXT = [
  'pem',
  'key',
  'p12',
  'pfx',
  'jks',
  'keystore',
  'bks',
  'ppk',
  'kdbx',
  'gpg',
  'pgp',
  'asc',
  'der',
  'crt',
  'cer',
  'tfvars',
  'tfvars.json',
  'tfstate',
  'tfstate.backup',
];

const BINARY_EXT = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'bmp',
  'tiff',
  'psd',
  'svg',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'zip',
  'gz',
  'tgz',
  'tar',
  'bz2',
  'xz',
  'zst',
  '7z',
  'rar',
  'pdf',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'mkv',
  'wav',
  'ogg',
  'flac',
  'wasm',
  'so',
  'dylib',
  'dll',
  'exe',
  'o',
  'a',
  'class',
  'jar',
  'pyc',
  'pyo',
  'bin',
  'dat',
  'db',
  'sqlite',
  'sqlite3',
  'lock',
  'map',
  'snap',
  'pb',
  'onnx',
  'safetensors',
  'parquet',
  'arrow',
  'ipynb',
];

const ENV_TEMPLATES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
]);

/** `lower` ends with `.<ext>` for some `ext` in `exts`. */
function hasExt(lower: string, exts: readonly string[]): boolean {
  return exts.some(
    (ext) => lower.length > ext.length && lower.endsWith(`.${ext}`),
  );
}

/** Credential material: exact names, `.env.*` variants (except committed templates), and key/vault extensions. */
function secret(name: string): boolean {
  if (SECRET_FILES.has(name)) return true;
  if (name.startsWith('.env.')) return !ENV_TEMPLATES.has(name);
  return hasExt(name.toLowerCase(), SECRET_EXT);
}

/** Whether a root-relative regular file is searchable. */
export function eligibleFile(
  rel: string,
  size: number,
  includeHidden: boolean,
): boolean {
  if (size <= 0) return false;
  const segments = rel.split('/');
  const name = segments[segments.length - 1];
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i];
    if (DENY_DIRS.has(dir) || (!includeHidden && dir.startsWith('.'))) {
      return false;
    }
  }
  if (!includeHidden && name.startsWith('.')) return false;
  return (
    !DENY_FILES.has(name) &&
    !secret(name) &&
    !hasExt(name.toLowerCase(), BINARY_EXT)
  );
}

export interface ListFilesOptions {
  includeHidden: boolean;
  /** Glob ignore patterns (the workspace's exclusions). */
  ignore: readonly string[];
  signal?: AbortSignal;
}

/**
 * Files the listing walk may consider before eligibility filtering, so one
 * pathological tree cannot pin the scan. Real source trees are far below this.
 */
const MAX_LISTED = 12_000;

/**
 * Every eligible, non-gitignored regular file under `root`, in path order.
 * Symlinked directories are not traversed. A file root is its only entry
 * unless it is credential material, a binary, or empty; being named explicitly
 * admits it even when hidden.
 */
export async function listFiles(
  root: SearchRoot,
  options: ListFilesOptions,
): Promise<FileEntry[]> {
  if (root.type === 'file') {
    return eligibleFile(path.basename(root.path), root.size, true)
      ? [{ path: root.path, rel: path.basename(root.path), size: root.size }]
      : [];
  }
  const entries: FileEntry[] = [];
  const stream = globStream('**/*', {
    cwd: root.path,
    dot: true,
    ignore: [...options.ignore],
    absolute: true,
    nodir: true,
    signal: options.signal,
  });
  for await (const absolute of stream) {
    if (entries.length >= MAX_LISTED) break;
    const rel = path.relative(root.path, absolute).split(path.sep).join('/');
    let size: number;
    try {
      size = (await fs.stat(absolute)).size;
    } catch {
      continue;
    }
    if (!eligibleFile(rel, size, options.includeHidden)) continue;
    entries.push({ path: absolute, rel, size });
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return entries;
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** `812 B`, `3.4 KB`, … */
export function humanSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

interface TreeNode {
  dirs: Map<string, TreeNode>;
  files: Array<{ index: number; name: string }>;
}

/**
 * Model-facing listing of `entries` as a prefix-folded directory tree: one `#`
 * per depth, `# dir/` headers, and every file line tagged with its question
 * key (`# e017 name (size)`), with a blank line before every directory header
 * and every root-level file after the first line.
 */
export function renderTree(
  entries: readonly FileEntry[],
  tagOf: (index: number) => string,
): string {
  const root: TreeNode = { dirs: new Map(), files: [] };
  entries.forEach((entry, index) => {
    const segments = entry.rel.split('/');
    let node = root;
    for (const dir of segments.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(dir, next);
      }
      node = next;
    }
    node.files.push({ index, name: segments[segments.length - 1] });
  });
  let out = '';
  let emitted = false;
  const emit = (blank: boolean, text: string): void => {
    if (emitted && blank) out += '\n';
    out += `${text}\n`;
    emitted = true;
  };
  const walk = (node: TreeNode, depth: number): void => {
    for (const [dir, child] of node.dirs) {
      // A chain of single-child directories folds into one header.
      let name = dir;
      let folded = child;
      while (folded.dirs.size === 1 && folded.files.length === 0) {
        const next = folded.dirs.entries().next().value;
        if (next === undefined) break;
        name += `/${next[0]}`;
        folded = next[1];
      }
      emit(true, `${'#'.repeat(depth + 1)} ${name}/`);
      walk(folded, depth + 1);
    }
    for (const file of node.files) {
      emit(
        depth === 0,
        `${'#'.repeat(depth + 1)} ${tagOf(file.index)} ${file.name} (${humanSize(entries[file.index].size)})`,
      );
    }
  };
  walk(root, 0);
  return out;
}
