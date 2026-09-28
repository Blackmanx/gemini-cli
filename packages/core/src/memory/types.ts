/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The seam between the memory bank and whatever drives it.
 *
 * This is a port of oh-my-pi's `memory-backend/types.ts` (`MemoryBackend`,
 * `MemoryBackendId`) onto a much smaller surface: four tools
 * (`retain`, `recall`, `reflect`, `memory_edit`) over one SQLite bank.
 *
 * It is additive to the file-based context memory that already exists
 * (`tools/memoryTool.ts` serving `GEMINI.md` + `MEMORY.md`): that module stays
 * the source of truth for curated project instructions, and the bank here is a
 * long-term, searchable store the model writes to itself.
 */

/** Which backend the session runs. `off` disables the bank entirely. */
export type MemoryBackendId = 'off' | 'local';

/** Partition a record lives in. `global` is shared by every project. */
export type MemoryScope = 'project' | 'global';

/**
 * Which bank inside a scope a record belongs to.
 *
 * `fact` is a durable statement about the project; `lesson` is a correction the
 * model learned the hard way. A `fact` that was projected from other records
 * (rather than written directly) is read-only — see `LocalMemoryBackend.edit`.
 */
export type MemoryStoreKind = 'fact' | 'lesson';

/** The four tools the memory bank exposes to the model. */
export type MemoryToolName = 'retain' | 'recall' | 'reflect' | 'memory_edit';

/** `memory_edit` operations. */
export type MemoryEditOp = 'update' | 'forget' | 'invalidate';

/** Result of a `memory_edit` operation. */
export type MemoryEditStatus =
  | 'updated'
  | 'deleted'
  | 'invalidated'
  | 'not_found'
  | 'not_editable';

/** One stored memory. */
export interface MemoryRecord {
  id: string;
  content: string;
  context?: string;
  scope: MemoryScope;
  store: MemoryStoreKind;
  /** 0..1, clamped on write. */
  importance: number;
  source?: string;
  sessionId?: string;
  cwd?: string;
  /** ISO-8601. */
  createdAt: string;
}

/** A stored memory with its ranking score attached, as returned by `recall`. */
export interface MemorySearchHit extends MemoryRecord {
  score: number;
}

/** One item handed to `retain`. */
export interface MemoryRetainItem {
  content: string;
  context?: string;
  scope?: MemoryScope;
}

/** Options for a `recall`. */
export interface MemoryRecallOptions {
  limit?: number;
  cwd: string;
  /** Also search the shared `global` partition. */
  includeGlobal?: boolean;
}

/** Patch accepted by `MemoryBackend.edit` for `op: 'update'`. */
export interface MemoryEditPatch {
  content?: string;
  importance?: number;
}

/** Session context threaded through every backend call. */
export interface MemoryOperationContext {
  cwd: string;
  sessionId?: string;
}

/** Structured state for `/memory` style commands and the settings UI. */
export interface MemoryStatus {
  available: boolean;
  count: number;
  backend: MemoryBackendId;
}

/**
 * A memory backend.
 *
 * Implementations own everything they open: `start()` acquires, `dispose()`
 * releases. Every method other than `developerInstructions()` requires a prior
 * `start()` and throws a descriptive error otherwise — a backend that was never
 * started is a wiring bug, not an empty bank.
 */
export interface MemoryBackend {
  readonly id: MemoryBackendId;

  /** Open the store. Called once per session before any other method. */
  start(ctx: MemoryOperationContext): Promise<void>;

  /** Markdown appended to the system prompt describing the tools. */
  developerInstructions(): string;

  status(): Promise<MemoryStatus>;

  retain(
    items: MemoryRetainItem[],
    ctx: MemoryOperationContext,
  ): Promise<{ stored: number }>;

  recall(
    query: string,
    opts: MemoryRecallOptions,
    signal?: AbortSignal,
  ): Promise<MemorySearchHit[]>;

  /**
   * Apply a single-record edit.
   *
   * `update` rewrites content/importance in place, `forget` deletes the record,
   * and `invalidate` tombstones it: the row stays for provenance but drops out
   * of `recall` and out of `status().count`.
   *
   * A derived `fact` projection is not editable — it is regenerated from the
   * records it was projected from, so an in-place write would be silently
   * reverted on the next consolidation. It answers `not_editable`; use
   * `forget`/`invalidate` on the source records instead.
   */
  edit(
    op: MemoryEditOp,
    id: string,
    patch: MemoryEditPatch | undefined,
    ctx: { cwd: string },
  ): Promise<MemoryEditStatus>;

  /** Wipe every record in the project partition for `cwd`. */
  clear(ctx: { cwd: string }): Promise<void>;

  /** Close the store. Safe to call more than once. */
  dispose(): Promise<void>;
}

export const MEMORY_RETAIN_TOOL_NAME = 'retain';
export const MEMORY_RECALL_TOOL_NAME = 'recall';
export const MEMORY_REFLECT_TOOL_NAME = 'reflect';
export const MEMORY_EDIT_TOOL_NAME = 'memory_edit';

/** Tools that exist only while a memory backend other than `off` is selected. */
export const MEMORY_BACKEND_TOOL_NAMES: readonly MemoryToolName[] = [
  MEMORY_RETAIN_TOOL_NAME,
  MEMORY_RECALL_TOOL_NAME,
  MEMORY_REFLECT_TOOL_NAME,
  MEMORY_EDIT_TOOL_NAME,
];
