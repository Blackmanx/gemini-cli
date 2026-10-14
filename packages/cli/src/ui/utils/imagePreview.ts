/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { PNG } from 'pngjs';

/** Supported image file extensions (same set clipboardUtils declares). */
export const PREVIEWABLE_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.heic',
  '.heif',
];

/** Default thumbnail size in terminal cells (half-blocks: 2 pixels per cell vertically). */
export const PREVIEW_MAX_COLS = 24;
export const PREVIEW_MAX_ROWS = 10;

export interface ImagePreview {
  /** ANSI half-block rows, or null when the format cannot be decoded. */
  thumbnail: string[] | null;
  width: number | null;
  height: number | null;
  byteSize: number;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PREVIEW_CACHE_MAX = 64;

const previewCache = new Map<string, ImagePreview>();

/** Clears the thumbnail cache (used by tests). */
export function clearImagePreviewCache(): void {
  previewCache.clear();
}

/**
 * Loads a preview for an image file. Only PNGs are decoded (clipboard saves
 * always produce PNG); any other format or a decode failure yields a
 * metadata-only preview so the caller can still show a label.
 */
export async function loadImagePreview(
  filePath: string,
  byteSize: number,
  maxCols = PREVIEW_MAX_COLS,
  maxRows = PREVIEW_MAX_ROWS,
): Promise<ImagePreview> {
  const cacheKey = `${filePath}|${byteSize}|${maxCols}x${maxRows}`;
  const cached = previewCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let preview: ImagePreview = {
    thumbnail: null,
    width: null,
    height: null,
    byteSize,
  };

  try {
    const handle = await fs.open(filePath, 'r');
    let isPng = false;
    try {
      const magic = Buffer.alloc(PNG_MAGIC.length);
      const { bytesRead } = await handle.read(
        magic,
        0,
        PNG_MAGIC.length,
        0,
      );
      isPng = bytesRead === PNG_MAGIC.length && magic.equals(PNG_MAGIC);
    } finally {
      await handle.close();
    }

    if (isPng) {
      const buffer = await fs.readFile(filePath);
      const png = PNG.sync.read(buffer);
      preview = {
        thumbnail: renderHalfBlocks(png.data, png.width, png.height, maxCols, maxRows),
        width: png.width,
        height: png.height,
        byteSize,
      };
    }
  } catch {
    // Unsupported format or corrupt data: keep the metadata-only preview.
  }

  while (previewCache.size >= PREVIEW_CACHE_MAX) {
    const oldestKey = previewCache.keys().next().value;
    if (oldestKey === undefined) break;
    previewCache.delete(oldestKey);
  }
  previewCache.set(cacheKey, preview);
  return preview;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function readPixel(data: Buffer, width: number, x: number, y: number): Rgb {
  const index = (y * width + x) * 4;
  return { r: data[index], g: data[index + 1], b: data[index + 2] };
}

/**
 * Renders image data as rows of `▀` half-blocks: foreground color is the top
 * pixel, background color the bottom one, so each terminal cell shows two
 * image pixels and the aspect ratio stays roughly correct in a terminal
 * (cells are about twice as tall as they are wide).
 */
export function renderHalfBlocks(
  data: Buffer,
  width: number,
  height: number,
  maxCols = PREVIEW_MAX_COLS,
  maxRows = PREVIEW_MAX_ROWS,
): string[] {
  if (width <= 0 || height <= 0) {
    return [];
  }
  const cols = Math.min(width, maxCols);
  const rows = Math.min(Math.ceil(height / 2), maxRows);
  const pixelRows = rows * 2;

  const output: string[] = [];
  for (let row = 0; row < rows; row++) {
    const topY = Math.min(Math.floor((row * 2 * height) / pixelRows), height - 1);
    const bottomY = Math.min(
      Math.floor(((row * 2 + 1) * height) / pixelRows),
      height - 1,
    );
    let line = '';
    for (let col = 0; col < cols; col++) {
      const x = Math.min(Math.floor((col * width) / cols), width - 1);
      const top = readPixel(data, width, x, topY);
      const bottom = readPixel(data, width, x, bottomY);
      line +=
        `\u001b[38;2;${top.r};${top.g};${top.b};` +
        `48;2;${bottom.r};${bottom.g};${bottom.b}m\u2580`;
    }
    output.push(`${line}\u001b[0m`);
  }
  return output;
}

/** Human-readable byte size for preview labels. */
export function formatImageSize(byteSize: number): string {
  if (byteSize >= 1024 * 1024) {
    return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(byteSize / 1024))} KB`;
}
