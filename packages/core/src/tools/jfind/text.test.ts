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
  clipBytes,
  countOccurrences,
  lines,
  readText,
  ReadTextError,
  takeChars,
} from './text.js';

describe('clipBytes', () => {
  it('never splits a multi-byte code point when the budget falls mid-character', () => {
    // 'é' is 2 bytes: a 3-byte budget can hold one whole 'é', not two.
    expect(clipBytes('ééé', 3)).toBe('é');
    expect(Buffer.byteLength(clipBytes('ééé', 3))).toBeLessThanOrEqual(3);
    expect(clipBytes('ééé', 4)).toBe('éé');
  });
});

describe('lines', () => {
  it('drops the phantom final line after a trailing newline and strips CR', () => {
    expect(lines('a\r\nb\n')).toEqual(['a', 'b']);
    expect(lines('')).toEqual([]);
  });
});

describe('countOccurrences', () => {
  it('counts non-overlapping matches and treats an empty needle as zero', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('anything', '')).toBe(0);
  });
});

describe('takeChars', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(takeChars('héllo', 2)).toBe('hé');
  });
});

describe('readText', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jfind-text-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects files containing a NUL byte in the first 8 KB as binary', async () => {
    const file = path.join(dir, 'bin.dat');
    await fs.writeFile(file, Buffer.from([0x74, 0x65, 0x78, 0x74, 0x00, 0x62]));
    await expect(readText(file, 1024)).rejects.toMatchObject({
      kind: 'binary',
    });
  });

  it('rejects files whose content is entirely blank as empty', async () => {
    const file = path.join(dir, 'blank.txt');
    await fs.writeFile(file, '   \n\t\n');
    await expect(readText(file, 1024)).rejects.toMatchObject({
      kind: 'empty',
    });
  });

  it('trims a truncated read back to the last full line and flags it', async () => {
    const file = path.join(dir, 'lines.txt');
    await fs.writeFile(file, 'alpha\nbravo\ncharlie\n');
    const result = await readText(file, 10);
    // 10 bytes cuts inside "bravo"; the partial line must not survive.
    expect(result.text).toBe('alpha\n');
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(6);
  });

  it('surfaces missing files as io failures carrying the errno message', async () => {
    const missing = path.join(dir, 'gone.txt');
    const error = await readText(missing, 100).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReadTextError);
    expect((error as ReadTextError).kind).toBe('io');
    expect((error as Error).message).toContain('ENOENT');
  });
});
