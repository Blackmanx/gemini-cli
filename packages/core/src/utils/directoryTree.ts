/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Rendered when the directory has nothing to list. */
const EMPTY_MARKER = '(empty directory)';

const SKIP_DIRS = new Set(['node_modules']);

interface Node {
  name: string;
  /** Absolute path this node was read from. */
  abs: string;
  isDir: boolean;
  mtimeMs: number;
  size: number;
  depth: number;
  children: Node[];
  /** When > 0, `children` is laid out as `[recent…, oldest]`. */
  droppedCount: number;
}

interface RenderedLine {
  label: string;
  depth: number;
  isRoot: boolean;
  size?: string;
  age?: string;
}

export interface DirectoryTreeOptions {
  /** Directory depth below the root to include. Root itself is depth 0. Default: 2. */
  maxDepth?: number;
  /** Per-directory child cap. Default: 12. */
  perDirLimit?: number;
  /** Reference time in ms for relative ages. Default: `Date.now()`. */
  now?: number;
}

interface DirEntryInfo {
  name: string;
  isDir: boolean;
  mtimeMs: number;
  size: number;
}

/** Format a byte count to a human-readable string (e.g. `512B`, `1.5KB`). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/** Format an age in seconds as `just now` / `Nm ago` / `2h ago` / `2d ago` / `3w ago` / `2mo ago`. */
function formatAge(ageSeconds: number): string {
  if (!ageSeconds) return '';
  const mins = Math.floor(ageSeconds / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  if (months > 0) return `${months}mo ago`;
  if (weeks > 0) return `${weeks}w ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'just now';
}

/** Directories before files, then newest first, then name. */
function byRecency(a: Node, b: Node): number {
  return (
    Number(b.isDir) - Number(a.isDir) ||
    b.mtimeMs - a.mtimeMs ||
    a.name.localeCompare(b.name)
  );
}

async function readDirEntries(abs: string): Promise<DirEntryInfo[]> {
  let dirents;
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DirEntryInfo[] = [];
  for (const dirent of dirents) {
    // Symlinks are skipped so a link cycle cannot trap the walk.
    if (dirent.isSymbolicLink()) continue;
    const isDir = dirent.isDirectory();
    if (isDir && SKIP_DIRS.has(dirent.name)) continue;
    try {
      const st = await fs.stat(path.join(abs, dirent.name));
      out.push({
        name: dirent.name,
        isDir,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    } catch {
      // Unreadable entries are skipped rather than failing the whole listing.
      continue;
    }
  }
  return out;
}

function renderNode(
  node: Node,
  formatNodeAge: (mtimeMs: number) => string,
  out: RenderedLine[],
): void {
  if (node.depth === 0) {
    out.push({ label: node.name, depth: 0, isRoot: true });
  } else {
    const indent = '  '.repeat(node.depth);
    const suffix = node.isDir ? '/' : '';
    out.push({
      label: `${indent}- ${node.name}${suffix}`,
      depth: node.depth,
      isRoot: false,
      size: node.isDir ? undefined : formatBytes(node.size),
      age: formatNodeAge(node.mtimeMs),
    });
  }

  if (node.droppedCount === 0) {
    for (const child of node.children) renderNode(child, formatNodeAge, out);
    return;
  }

  // Layout: recent children, then the "… N more" marker, then the oldest child.
  const recent = node.children.slice(0, -1);
  const oldest = node.children[node.children.length - 1];
  for (const child of recent) renderNode(child, formatNodeAge, out);
  const childDepth = node.depth + 1;
  out.push({
    label: `${'  '.repeat(childDepth)}- … ${node.droppedCount} more`,
    depth: childDepth,
    isRoot: false,
  });
  if (oldest) renderNode(oldest, formatNodeAge, out);
}

function formatLines(lines: readonly RenderedLine[]): string {
  const maxLabelLength = lines.reduce(
    (max, line) => Math.max(max, line.label.length),
    0,
  );
  return lines
    .map((line) => {
      if (!line.age) return line.label;
      const sizeColumn = (line.size ?? '').padEnd(8);
      return `${line.label.padEnd(maxLabelLength + 2)}${sizeColumn}  ${line.age.padEnd(4)}`.trimEnd();
    })
    .join('\n');
}

/**
 * Render `dir` the way omp's `read` does when pointed at a folder: a `.` root
 * line, children indented two spaces per level, directories before files,
 * newest-first ordering by mtime, relative ages, a `… N more` marker when the
 * per-directory cap truncates, and `(empty directory)` when there is nothing
 * to show. `node_modules` is skipped; unreadable entries are skipped.
 */
export async function buildDirectoryTree(
  dir: string,
  opts: DirectoryTreeOptions = {},
): Promise<string> {
  const rootPath = path.resolve(dir);
  const maxDepth = opts.maxDepth ?? 2;
  const perDirLimit = opts.perDirLimit ?? 12;
  const nowMs = opts.now ?? Date.now();

  const root: Node = {
    name: '.',
    abs: rootPath,
    isDir: true,
    mtimeMs: 0,
    size: 0,
    depth: 0,
    children: [],
    droppedCount: 0,
  };

  const queue: Node[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const entries = await readDirEntries(node.abs);
    const all: Node[] = entries.map((entry) => ({
      name: entry.name,
      abs: path.join(node.abs, entry.name),
      isDir: entry.isDir,
      mtimeMs: entry.mtimeMs,
      size: entry.size,
      depth: node.depth + 1,
      children: [],
      droppedCount: 0,
    }));
    all.sort(byRecency);
    if (all.length > perDirLimit) {
      node.children =
        perDirLimit <= 1
          ? all.slice(0, Math.max(0, perDirLimit))
          : [...all.slice(0, perDirLimit - 1), all[all.length - 1]];
      node.droppedCount = all.length - perDirLimit;
    } else {
      node.children = all;
    }
    if (node.depth < maxDepth) {
      for (const child of node.children) {
        if (child.isDir) queue.push(child);
      }
    }
  }

  const formatNodeAge = (mtimeMs: number): string =>
    formatAge(Math.max(0, Math.floor((nowMs - mtimeMs) / 1000)));

  const lines: RenderedLine[] = [];
  renderNode(root, formatNodeAge, lines);
  if (lines.length <= 1) return EMPTY_MARKER;
  return formatLines(lines);
}
