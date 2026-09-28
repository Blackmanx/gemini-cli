/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

interface TreeNode {
  files: string[];
  subdirs: Map<string, TreeNode>;
}

function createNode(): TreeNode {
  return { files: [], subdirs: new Map() };
}

function buildTree(paths: readonly string[]): TreeNode {
  const root = createNode();
  for (const raw of paths) {
    const normalized = raw.replace(/\\/g, '/');
    const isDir = normalized.endsWith('/') && normalized.length > 1;
    const trimmed = isDir ? normalized.slice(0, -1) : normalized;
    if (trimmed.length === 0) continue;
    const segments = trimmed.split('/');
    const dirCount = isDir ? segments.length : segments.length - 1;
    let node = root;
    for (let i = 0; i < dirCount; i++) {
      const segment = segments[i];
      let child = node.subdirs.get(segment);
      if (!child) {
        child = createNode();
        node.subdirs.set(segment, child);
      }
      node = child;
    }
    if (!isDir) {
      const name = segments[segments.length - 1];
      if (!node.files.includes(name)) node.files.push(name);
    }
  }
  return root;
}

function sortedFiles(node: TreeNode): string[] {
  return [...node.files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sortedSubdirs(node: TreeNode): Array<[string, TreeNode]> {
  return [...node.subdirs.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
}

/**
 * Render a flat list of relative paths as a prefix-folded tree.
 *
 * Entries sharing a directory prefix are listed under a single `# a/b/c/` header,
 * and single-child directory chains fold into that one header, so a deep result
 * set costs one token per shared segment instead of one per file. Directories
 * sort before files and each group sorts lexicographically, so output is stable.
 *
 * With `headerComment: false` headers are dropped and every file is printed as its
 * full relative path.
 */
export function formatGroupedPaths(
  paths: readonly string[],
  opts?: { indent?: string; headerComment?: boolean },
): string {
  if (paths.length === 0) return '';
  const indent = opts?.indent ?? '';
  const headerComment = opts?.headerComment ?? true;
  const lines: string[] = [];

  const walk = (node: TreeNode, depth: number, prefix: string): void => {
    for (const file of sortedFiles(node)) {
      lines.push(
        headerComment
          ? indent.repeat(depth) + file
          : indent.repeat(depth) + prefix + file,
      );
    }
    for (const [name, child] of sortedSubdirs(node)) {
      let dirNode = child;
      const parts = [name];
      while (dirNode.files.length === 0 && dirNode.subdirs.size === 1) {
        const only = [...dirNode.subdirs.entries()][0];
        parts.push(only[0]);
        dirNode = only[1];
      }
      if (headerComment) {
        lines.push(
          `${indent.repeat(depth)}${'#'.repeat(depth + 1)} ${parts.join('/')}/`,
        );
      }
      walk(dirNode, depth + 1, `${prefix}${parts.join('/')}/`);
    }
  };

  walk(buildTree(paths), 0, '');
  return lines.join('\n');
}
