/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { candidatePenalty, fileScore, grepIndex, idf } from './lexical.js';
import type { FileEntry } from './tree.js';

describe('grepIndex', () => {
  let dir: string;
  let entries: FileEntry[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jfind-lex-'));
    const auth = path.join(dir, 'auth.ts');
    await fs.writeFile(
      auth,
      'function login() { return authenticate(); }\nauthenticate();\nconst unused = 1;\n',
    );
    const other = path.join(dir, 'other.ts');
    await fs.writeFile(other, 'nothing relevant here\n');
    entries = [
      { path: auth, rel: 'auth.ts', size: (await fs.stat(auth)).size },
      { path: other, rel: 'other.ts', size: (await fs.stat(other)).size },
    ];
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('counts occurrences only on lines that contain a keyword', async () => {
    const index = await grepIndex(entries, ['authenticate']);
    expect(index.keywords).toEqual(['authenticate']);
    // 1 match on line 1 + 1 on line 2; line 3 never matched.
    expect(index.perFileKw.get('auth.ts')).toEqual([2]);
    expect(index.perFileKw.has('other.ts')).toBe(false);
    expect(index.filesScanned).toBe(2);
  });

  it('is case-insensitive and lowercases the keyword vectors', async () => {
    const index = await grepIndex(entries, ['Authenticate']);
    expect(index.keywords).toEqual(['authenticate']);
    expect(index.perFileKw.get('auth.ts')).toEqual([2]);
  });

  it('skips scanning entirely when no keyword survives', async () => {
    const index = await grepIndex(entries, ['']);
    expect(index.keywords).toEqual([]);
    expect(index.perFileKw.size).toBe(0);
    expect(index.filesScanned).toBe(2);
  });
});

describe('idf', () => {
  it('clamps rarity weight into [0.5, 6]', () => {
    // Keyword in every file: log(2/2) = 0 → raised to the 0.5 floor.
    const common = idf({
      keywords: ['k'],
      perFileKw: new Map([
        ['a', [1]],
        ['b', [1]],
      ]),
      filesScanned: 2,
    });
    expect(common[0]).toBe(0.5);

    // Zero document frequency in a huge corpus: log(1001) ≈ 6.9 → capped at 6.
    const rare = idf({
      keywords: ['k'],
      perFileKw: new Map([['a', [0]]]),
      filesScanned: 1000,
    });
    expect(rare[0]).toBe(6);
  });
});

describe('fileScore', () => {
  it('adds frequency, rarity, and a two-weight bonus for a keyword in the path', () => {
    const keywords = ['authenticate'];
    const weights = [1];
    // No occurrences, no path hint: nothing.
    expect(fileScore([0], weights, 'src/other.ts', keywords)).toBe(0);
    // One occurrence in the body: log(2).
    expect(fileScore([1], weights, 'src/other.ts', keywords)).toBeCloseTo(
      Math.log(2),
    );
    // No body occurrence, but the file name itself matches: 2 weight units.
    expect(fileScore([0], weights, 'src/authenticate.ts', keywords)).toBe(2);
  });
});

describe('candidatePenalty', () => {
  it('keeps ordinary source files at full weight', () => {
    expect(candidatePenalty('src/api/routers/usuarios.py')).toBe(1);
    expect(candidatePenalty('lib/services/user_service.ts')).toBe(1);
    expect(candidatePenalty('docs/scripts/alta_usuario.sh')).toBe(1);
  });

  it('demotes tool output, cache, and vendor trees', () => {
    expect(candidatePenalty('graphify-out/2026-10-05/GRAPH_REPORT.md')).toBe(
      0.3,
    );
    expect(candidatePenalty('svc/cache/ast/abc.json')).toBe(0.3);
    expect(candidatePenalty('third_party/lib/code.py')).toBe(0.3);
    expect(candidatePenalty('src/tmp/scratch.ts')).toBe(0.3);
  });

  it('demotes prose and rendered reports but keeps them searchable', () => {
    expect(candidatePenalty('docs/guide.md')).toBe(0.5);
    expect(candidatePenalty('site/index.html')).toBe(0.5);
    expect(candidatePenalty('notes.rst')).toBe(0.5);
    // A file merely containing `-out` is not a generated directory.
    expect(candidatePenalty('src/check-out.ts')).toBe(1);
  });
});
