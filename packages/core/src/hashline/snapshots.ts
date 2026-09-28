/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileHash } from './hash.js';

/** Inclusive 1-based line range. */
export type LineRange = [number, number];

/**
 * What the model was actually shown for one file version.
 *
 * `content` is the exact text that was hashed into `tag`; `seenRanges` is the
 * part of it that reached the model's context. A read of the whole file
 * covers `[1, lineCount]`. A partial read, a `grep` hit and a folded summary
 * each cover a much smaller set, and an edit anchored outside that set is
 * refused rather than guessed at.
 */
export interface Snapshot {
  content: string;
  tag: string;
  seenRanges: LineRange[];
}

/**
 * Versions retained per path. A model that reads, edits, re-reads and edits
 * again needs the previous version to still be addressable by tag, because it
 * may still be holding that tag in an unapplied edit.
 */
const MAX_VERSIONS_PER_PATH = 4;

/** Content above this size is hashed but never retained. */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/** Total retained content across every path, oldest versions evicted first. */
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

/**
 * Sort ranges and merge any that overlap or touch, so membership tests are a
 * single pass and adjacent reads of the same file collapse into one range.
 */
export function normalizeRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
): LineRange[] {
  const sorted: LineRange[] = [];
  for (const entry of ranges) {
    const start = Math.max(1, Math.min(entry[0], entry[1]));
    const end = Math.max(entry[0], entry[1]);
    if (end < 1) {
      continue;
    }
    sorted.push([start, end]);
  }
  sorted.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1] + 1) {
      if (range[1] > last[1]) {
        last[1] = range[1];
      }
      continue;
    }
    merged.push([range[0], range[1]]);
  }
  return merged;
}

/** Whether `line` falls inside any of the (already normalised) ranges. */
export function coversLine(
  ranges: ReadonlyArray<readonly [number, number]>,
  line: number,
): boolean {
  for (const range of ranges) {
    if (line >= range[0] && line <= range[1]) {
      return true;
    }
  }
  return false;
}

/** Copy a snapshot so callers cannot mutate the store's retained state. */
function cloneSnapshot(snapshot: Snapshot): Snapshot {
  const ranges: LineRange[] = [];
  for (const range of snapshot.seenRanges) {
    ranges.push([range[0], range[1]]);
  }
  return { content: snapshot.content, tag: snapshot.tag, seenRanges: ranges };
}

/**
 * Session-scoped record of every file version the model has been shown,
 * newest first per path.
 *
 * This is the only thing that makes a hashline edit safe: without it a tag
 * proves nothing, because there would be no record of which bytes the tag was
 * minted from or which of those bytes the model actually saw.
 */
export class SnapshotStore {
  readonly #byPath = new Map<string, Snapshot[]>();
  #totalBytes = 0;

  /**
   * Record the content the model was just shown and return its tag.
   *
   * Re-recording content that is already retained returns the existing tag,
   * promotes that version back to the head and unions the newly seen ranges
   * into it: two reads of the same file have shown the model more lines, not
   * produced a second version.
   */
  record(path: string, content: string, seenRanges: LineRange[]): string {
    const tag = fileHash(content);
    const versions = this.#byPath.get(path);
    if (versions !== undefined) {
      for (let index = 0; index < versions.length; index += 1) {
        const existing = versions[index];
        if (existing.tag !== tag) {
          continue;
        }
        existing.seenRanges = normalizeRanges(
          existing.seenRanges.concat(seenRanges),
        );
        if (index > 0) {
          versions.splice(index, 1);
          versions.unshift(existing);
        }
        return tag;
      }
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_SNAPSHOT_BYTES) {
      return tag;
    }
    const snapshot: Snapshot = {
      content,
      tag,
      seenRanges: normalizeRanges(seenRanges),
    };
    const retained =
      versions === undefined ? [snapshot] : [snapshot, ...versions];
    this.#byPath.set(path, retained);
    this.#totalBytes += Buffer.byteLength(content, 'utf8');
    this.#evict();
    return tag;
  }

  /** The most recently recorded version of `path`, if any. */
  get(path: string): Snapshot | undefined {
    const versions = this.#byPath.get(path);
    const head = versions?.[0];
    return head === undefined ? undefined : cloneSnapshot(head);
  }

  /** The retained version of `path` carrying `tag`, if it is still held. */
  getByTag(path: string, tag: string): Snapshot | undefined {
    const versions = this.#byPath.get(path);
    if (versions === undefined) {
      return undefined;
    }
    for (const version of versions) {
      if (version.tag === tag) {
        return cloneSnapshot(version);
      }
    }
    return undefined;
  }

  /** Drop every retained version of `path`. */
  forget(path: string): void {
    const versions = this.#byPath.get(path);
    if (versions === undefined) {
      return;
    }
    for (const version of versions) {
      this.#totalBytes -= Buffer.byteLength(version.content, 'utf8');
    }
    this.#byPath.delete(path);
  }

  /** Enforce both retention bounds, newest first, so the head always survives. */
  #evict(): void {
    for (const versions of this.#byPath.values()) {
      while (versions.length > MAX_VERSIONS_PER_PATH) {
        const dropped = versions.pop();
        if (dropped !== undefined) {
          this.#totalBytes -= Buffer.byteLength(dropped.content, 'utf8');
        }
      }
    }
    // Round-robin across paths, oldest tail first, until back under budget.
    let evicted = true;
    while (this.#totalBytes > MAX_TOTAL_BYTES && evicted) {
      evicted = false;
      for (const versions of this.#byPath.values()) {
        const dropped = versions.pop();
        if (dropped === undefined) {
          continue;
        }
        this.#totalBytes -= Buffer.byteLength(dropped.content, 'utf8');
        evicted = true;
      }
    }
  }
}
