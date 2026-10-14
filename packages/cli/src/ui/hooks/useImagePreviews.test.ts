/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { clearImagePreviewEntries, extractImageAtPaths } from './useImagePreviews.js';

describe('extractImageAtPaths', () => {
  const targetDir = '/proj';

  it('returns an empty list when there are no image references', () => {
    expect(extractImageAtPaths('', targetDir)).toEqual([]);
    expect(extractImageAtPaths('just some text', targetDir)).toEqual([]);
  });

  it('resolves relative image references against the target dir', () => {
    const refs = extractImageAtPaths('look at @.gemini-clipboard/x.png', targetDir);

    expect(refs).toHaveLength(1);
    expect(refs[0].absPath).toBe(path.join(targetDir, '.gemini-clipboard/x.png'));
    expect(refs[0].relPath).toBe(path.join('.gemini-clipboard', 'x.png'));
  });

  it('keeps absolute references as-is', () => {
    const refs = extractImageAtPaths('@/tmp/pic.jpg', targetDir);

    expect(refs[0].absPath).toBe('/tmp/pic.jpg');
  });

  it('ignores non-image references and unknown extensions', () => {
    const refs = extractImageAtPaths(
      '@src/index.ts @notes.txt @README',
      targetDir,
    );

    expect(refs).toEqual([]);
  });

  it('supports quoted paths with spaces', () => {
    const refs = extractImageAtPaths('@"my screenshots/two words.png"', targetDir);

    expect(refs).toHaveLength(1);
    expect(refs[0].relPath).toBe(path.join('my screenshots', 'two words.png'));
  });

  it('deduplicates repeated references', () => {
    const refs = extractImageAtPaths('@a.png @a.png @b.png', targetDir);

    expect(refs.map((r) => r.relPath)).toEqual(['a.png', 'b.png']);
  });

  it('caps the number of previews to the most recent references', () => {
    const refs = extractImageAtPaths('@1.png @2.png @3.png', targetDir);

    expect(refs.map((r) => r.relPath)).toEqual(['2.png', '3.png']);
  });

  it('does not treat an escaped @ as a reference', () => {
    const refs = extractImageAtPaths('\\@a.png', targetDir);

    expect(refs).toEqual([]);
  });

  it('clearImagePreviewEntries empties the resolution cache', async () => {
    // Smoke: the cache helper exists and does not throw.
    expect(() => clearImagePreviewEntries()).not.toThrow();
  });
});
