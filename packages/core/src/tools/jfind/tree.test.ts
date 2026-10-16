/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  eligibleFile,
  humanSize,
  listFiles,
  renderTree,
  resolveSearchRoot,
} from './tree.js';

describe('eligibleFile', () => {
  it('accepts regular source files and rejects empty ones', () => {
    expect(eligibleFile('src/app.ts', 10, false)).toBe(true);
    expect(eligibleFile('src/app.ts', 0, false)).toBe(false);
  });

  it('rejects build output and dependency directories by name', () => {
    expect(eligibleFile('node_modules/pkg/index.js', 10, false)).toBe(false);
    expect(eligibleFile('dist/bundle.js', 10, false)).toBe(false);
    expect(eligibleFile('.git/config', 10, true)).toBe(false);
  });

  it('never lists credential material, even with hidden files included', () => {
    expect(eligibleFile('.env', 10, true)).toBe(false);
    expect(eligibleFile('id_rsa', 10, true)).toBe(false);
    expect(eligibleFile('src/cert.pem', 10, true)).toBe(false);
    expect(eligibleFile('.env.local', 10, true)).toBe(false);
  });

  it('keeps committed env templates and hidden sources when hidden is allowed', () => {
    expect(eligibleFile('.env.example', 10, true)).toBe(true);
    expect(eligibleFile('src/.hidden.ts', 10, true)).toBe(true);
    expect(eligibleFile('.env.example', 10, false)).toBe(false);
    expect(eligibleFile('src/.hidden.ts', 10, false)).toBe(false);
  });

  it('rejects binary and lockfile names', () => {
    expect(eligibleFile('assets/logo.svg', 10, false)).toBe(false);
    expect(eligibleFile('package-lock.json', 10, false)).toBe(false);
  });
});

describe('resolveSearchRoot', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jfind-tree-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('resolves an empty scope to the working directory', async () => {
    await expect(resolveSearchRoot('', dir)).resolves.toEqual({
      path: path.resolve(dir),
      type: 'directory',
    });
  });

  it('resolves an existing file with its size and a missing path with an error', async () => {
    const file = path.join(dir, 'a.ts');
    await fs.writeFile(file, 'abc');
    const root = await resolveSearchRoot('a.ts', dir);
    expect(root).toEqual({ path: file, type: 'file', size: 3 });
    await expect(resolveSearchRoot('gone.ts', dir)).rejects.toThrow(
      'Path not found: gone.ts',
    );
  });
});

describe('listFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jfind-list-'));
    const write = async (rel: string, body = 'x'): Promise<void> => {
      const target = path.join(dir, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
    };
    await write('deep/nested/file.ts');
    await write('src/a.ts');
    await write('.env', 'SECRET=1');
    await write('.hidden.ts');
    await write('.cache/c.ts');
    await write('node_modules/pkg/index.js');
    await write('dist/bundle.js');
    await write('package-lock.json', '{}');
    await write('empty.txt', '');
    await write('ignored.txt');
    await write('debug.log');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns only eligible files, sorted by relative path, honoring ignore patterns', async () => {
    const entries = await listFiles(
      { path: dir, type: 'directory' },
      { includeHidden: false, ignore: ['ignored.txt', '**/*.log'] },
    );
    expect(entries.map((entry) => entry.rel)).toEqual([
      'deep/nested/file.ts',
      'src/a.ts',
    ]);
    // rel paths are root-relative with forward slashes even on Windows.
    expect(entries[0].path).toBe(path.join(dir, 'deep', 'nested', 'file.ts'));
  });

  it('admits a file root even when hidden, but never credential files', async () => {
    const hidden = path.join(dir, '.hidden.ts');
    expect(
      await listFiles(
        { path: hidden, type: 'file', size: 1 },
        { includeHidden: false, ignore: [] },
      ),
    ).toEqual([{ path: hidden, rel: '.hidden.ts', size: 1 }]);

    const env = path.join(dir, '.env');
    expect(
      await listFiles(
        { path: env, type: 'file', size: 8 },
        { includeHidden: true, ignore: [] },
      ),
    ).toEqual([]);
  });
});

describe('renderTree', () => {
  const tagOf = (index: number): string => `e${String(index).padStart(3, '0')}`;

  it('folds directory headers, tags every file, and separates root files with a blank line', () => {
    const out = renderTree(
      [
        { path: '/w/src/a.ts', rel: 'src/a.ts', size: 5 },
        { path: '/w/src/b.ts', rel: 'src/b.ts', size: 1500 },
        { path: '/w/top.ts', rel: 'top.ts', size: 10 },
      ],
      tagOf,
    );
    expect(out).toBe(
      '# src/\n' +
        '## e000 a.ts (5 B)\n' +
        '## e001 b.ts (1.5 KB)\n' +
        '\n' +
        '# e002 top.ts (10 B)\n',
    );
  });

  it('folds a single-child directory chain into one header', () => {
    const out = renderTree(
      [{ path: '/w/a/b/c/d.ts', rel: 'a/b/c/d.ts', size: 5 }],
      tagOf,
    );
    expect(out).toBe('# a/b/c/\n## e000 d.ts (5 B)\n');
  });
});

describe('humanSize', () => {
  it('formats bytes and promotes at 1024', () => {
    expect(humanSize(812)).toBe('812 B');
    expect(humanSize(1536)).toBe('1.5 KB');
  });
});
