/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  loadImagePreview,
  PREVIEWABLE_IMAGE_EXTENSIONS,
  type ImagePreview,
} from '../utils/imagePreview.js';

export interface ImagePreviewEntry {
  absPath: string;
  relPath: string;
  preview: ImagePreview;
}

/** At most this many previews render at once (most recently referenced last). */
const MAX_IMAGE_PREVIEWS = 2;
const ENTRY_CACHE_MAX = 64;

/** `@path` references; double quotes allow spaces, backslash escapes a literal @. */
const AT_IMAGE_PATH_REGEX = /(?<!\\)@(?:"([^"]+)"|([^\s]+))/g;

const entryCache = new Map<string, ImagePreviewEntry | null>();

function putEntry(absPath: string, entry: ImagePreviewEntry | null): void {
  while (entryCache.size >= ENTRY_CACHE_MAX) {
    const oldestKey = entryCache.keys().next().value;
    if (oldestKey === undefined) break;
    entryCache.delete(oldestKey);
  }
  entryCache.set(absPath, entry);
}

/** Clears the resolved-entry cache (used by tests). */
export function clearImagePreviewEntries(): void {
  entryCache.clear();
}

/**
 * Extracts the image references (`@path` tokens with a known image
 * extension) from the composer text, preserving order and uniqueness.
 */
export function extractImageAtPaths(
  text: string,
  targetDir: string,
): Array<{ absPath: string; relPath: string }> {
  const found: Array<{ absPath: string; relPath: string }> = [];
  const seen = new Set<string>();
  AT_IMAGE_PATH_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AT_IMAGE_PATH_REGEX.exec(text)) !== null) {
    const rawPath = match[1] ?? match[2];
    if (rawPath === undefined || rawPath === '') continue;
    const ext = path.extname(rawPath).toLowerCase();
    if (!PREVIEWABLE_IMAGE_EXTENSIONS.includes(ext)) continue;
    const absPath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(targetDir, rawPath);
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    const relPath = path.relative(targetDir, absPath) || absPath;
    found.push({ absPath, relPath });
  }
  return found.slice(-MAX_IMAGE_PREVIEWS);
}

/**
 * Resolves image previews for the `@path` references currently in the
 * composer buffer. Decoding is async and cached, so typing only re-resolves
 * references that are new; previews disappear when their reference leaves
 * the buffer (including after submit).
 */
export function useImagePreviews(
  bufferText: string,
  targetDir: string,
  enabled: boolean,
): ImagePreviewEntry[] {
  const [entries, setEntries] = useState<ImagePreviewEntry[]>([]);

  useEffect(() => {
    if (!enabled || bufferText === '') {
      setEntries((previous) => (previous.length === 0 ? previous : []));
      return;
    }

    let cancelled = false;
    const refs = extractImageAtPaths(bufferText, targetDir);

    void (async () => {
      const loaded: ImagePreviewEntry[] = [];
      for (const ref of refs) {
        const cached = entryCache.get(ref.absPath);
        let entry: ImagePreviewEntry | undefined;
        if (cached !== undefined) {
          entry = cached ?? undefined;
        } else {
          try {
            const stats = await fs.stat(ref.absPath);
            if (stats.isFile()) {
              const preview = await loadImagePreview(ref.absPath, stats.size);
              entry = { absPath: ref.absPath, relPath: ref.relPath, preview };
            }
          } catch {
            // Missing or unreadable file: no preview.
          }
          putEntry(ref.absPath, entry ?? null);
        }
        if (entry !== undefined) {
          loaded.push(entry);
        }
      }
      if (!cancelled) {
        setEntries(loaded);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bufferText, targetDir, enabled]);

  return entries;
}
