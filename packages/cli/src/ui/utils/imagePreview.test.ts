/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import {
  clearImagePreviewCache,
  formatImageSize,
  loadImagePreview,
  renderHalfBlocks,
} from './imagePreview.js';

/** Creates a solid-color PNG of the given size on disk. */
async function writePng(
  filePath: string,
  width: number,
  height: number,
  rgb: [number, number, number],
): Promise<Buffer> {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    png.data[offset] = rgb[0];
    png.data[offset + 1] = rgb[1];
    png.data[offset + 2] = rgb[2];
    png.data[offset + 3] = 255;
  }
  const buffer = PNG.sync.write(png);
  await fs.writeFile(filePath, buffer);
  return buffer;
}

const testDir = mkdtempSync(path.join(tmpdir(), 'image-preview-test-'));

describe('imagePreview', () => {
  beforeEach(() => {
    clearImagePreviewCache();
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('loadImagePreview', () => {
    it('decodes a PNG into half-block rows with dimensions', async () => {
      const filePath = path.join(testDir, 'solid.png');
      await writePng(filePath, 4, 4, [255, 0, 0]);
      const stat = await fs.stat(filePath);

      const preview = await loadImagePreview(filePath, stat.size);

      expect(preview.width).toBe(4);
      expect(preview.height).toBe(4);
      expect(preview.byteSize).toBe(stat.size);
      expect(preview.thumbnail).not.toBeNull();
      // 4px tall => 2 half-block rows.
      expect(preview.thumbnail).toHaveLength(2);
      expect(preview.thumbnail![0]).toContain('\u2580');
      // Solid red: foreground (top) color is 255,0,0.
      expect(preview.thumbnail![0]).toContain('\u001b[38;2;255;0;0;');
      expect(preview.thumbnail![0].endsWith('\u001b[0m')).toBe(true);
    });

    it('caps the thumbnail at the requested cell size', async () => {
      const filePath = path.join(testDir, 'large.png');
      await writePng(filePath, 100, 100, [0, 255, 0]);
      const stat = await fs.stat(filePath);

      const preview = await loadImagePreview(filePath, stat.size, 10, 5);

      expect(preview.thumbnail).toHaveLength(5);
      const cells = (preview.thumbnail![0].match(/\u2580/g) ?? []).length;
      expect(cells).toBe(10);
    });

    it('returns a metadata-only preview for non-PNG files', async () => {
      const filePath = path.join(testDir, 'photo.jpg');
      await fs.writeFile(filePath, 'not really a jpeg');

      const preview = await loadImagePreview(filePath, 17);

      expect(preview.thumbnail).toBeNull();
      expect(preview.width).toBeNull();
      expect(preview.byteSize).toBe(17);
    });

    it('returns a metadata-only preview for a corrupt PNG', async () => {
      const filePath = path.join(testDir, 'corrupt.png');
      const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await fs.writeFile(filePath, Buffer.concat([magic, Buffer.from('garbage')]));

      const preview = await loadImagePreview(filePath, 15);

      expect(preview.thumbnail).toBeNull();
      expect(preview.width).toBeNull();
    });

    it('caches previews per file and size', async () => {
      const filePath = path.join(testDir, 'cached.png');
      await writePng(filePath, 2, 2, [0, 0, 255]);
      const stat = await fs.stat(filePath);

      const first = await loadImagePreview(filePath, stat.size);
      const second = await loadImagePreview(filePath, stat.size);

      expect(second).toBe(first);
    });
  });

  describe('renderHalfBlocks', () => {
    it('renders two image pixels per cell (top as foreground, bottom as background)', () => {
      // 2x2: top row white, bottom row black.
      const data = Buffer.from([
        255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255,
      ]);

      const rows = renderHalfBlocks(data, 2, 2);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toBe(
        '\u001b[38;2;255;255;255;48;2;0;0;0m\u2580' +
          '\u001b[38;2;255;255;255;48;2;0;0;0m\u2580' +
          '\u001b[0m',
      );
    });

    it('returns no rows for empty dimensions', () => {
      expect(renderHalfBlocks(Buffer.alloc(0), 0, 0)).toEqual([]);
    });
  });

  describe('formatImageSize', () => {
    it('formats kilobytes and megabytes', () => {
      expect(formatImageSize(512)).toBe('1 KB');
      expect(formatImageSize(2048)).toBe('2 KB');
      expect(formatImageSize(5 * 1024 * 1024)).toBe('5.0 MB');
    });
  });
});
