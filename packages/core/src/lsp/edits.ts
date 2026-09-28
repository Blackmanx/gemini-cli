/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isRecord } from '../utils/markdownUtils.js';
import type {
  CreateFileOptions,
  DeleteFileOptions,
  DocumentChange,
  Position,
  Range,
  RenameFileOptions,
  TextEdit,
  WorkspaceEdit,
} from './types.js';

/** Failure raised while planning or applying a server-supplied edit. */
export class LspEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LspEditError';
  }
}

/** Convert an absolute or relative path to a `file://` URI. */
export function fileToUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

/** Convert a `file://` URI back to a filesystem path; other schemes pass through. */
export function uriToFile(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    return decodeURIComponent(uri.slice('file://'.length));
  }
}

function comparePosition(a: Position, b: Position): number {
  return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function positionsEqual(a: Position, b: Position): boolean {
  return a.line === b.line && a.character === b.character;
}

function rangesEqual(a: Range, b: Range): boolean {
  return positionsEqual(a.start, b.start) && positionsEqual(a.end, b.end);
}

function isEmptyRange(range: Range): boolean {
  return positionsEqual(range.start, range.end);
}

function formatRange(range: Range): string {
  return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

/** True when two ranges share any position other than a touching boundary. */
export function rangesOverlap(a: Range, b: Range): boolean {
  return (
    comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0
  );
}

/**
 * Sort edits bottom-to-top for in-place application and reject overlaps.
 *
 * Equal start positions tiebreak by original array index descending, so
 * inserts applied bottom-up land in array order (LSP: the order of edits in the
 * array defines the order in the result). Byte-identical non-empty range edits
 * are idempotent, so duplicate server output is collapsed before validation.
 */
export function sortAndValidateTextEdits(
  edits: readonly TextEdit[],
): TextEdit[] {
  for (const edit of edits) {
    if (edit.insertTextFormat === 2) {
      throw new LspEditError('snippet-formatted LSP edits are unsupported');
    }
  }

  const sorted = edits
    .map((edit, index) => ({ edit, index }))
    .sort((a, b) => {
      if (a.edit.range.start.line !== b.edit.range.start.line) {
        return b.edit.range.start.line - a.edit.range.start.line;
      }
      if (a.edit.range.start.character !== b.edit.range.start.character) {
        return b.edit.range.start.character - a.edit.range.start.character;
      }
      return b.index - a.index;
    })
    .map((entry) => entry.edit);

  const unique: TextEdit[] = [];
  for (const edit of sorted) {
    const previous = unique[unique.length - 1];
    if (
      previous &&
      !isEmptyRange(edit.range) &&
      rangesEqual(previous.range, edit.range) &&
      previous.newText === edit.newText
    ) {
      continue;
    }
    unique.push(edit);
  }

  // In reverse-sorted order each edit's end must sit at or before the next
  // edit's start, otherwise applying bottom-up makes them clobber each other.
  for (let i = 0; i < unique.length - 1; i++) {
    const later = unique[i].range;
    const earlier = unique[i + 1].range;
    if (comparePosition(earlier.end, later.start) > 0) {
      throw new LspEditError(
        `overlapping LSP edits: ${formatRange(earlier)} conflicts with ${formatRange(later)}; ` +
          'the server produced inconsistent edits',
      );
    }
  }

  return unique;
}

/**
 * Apply text edits to a string in memory, bottom-to-top so earlier
 * line/character indices stay valid.
 */
export function applyTextEditsToString(
  content: string,
  edits: readonly TextEdit[],
): string {
  if (edits.length === 0) return content;
  const lines = content.split('\n');
  const sorted = sortAndValidateTextEdits(edits);

  for (const edit of sorted) {
    const { start, end } = edit.range;
    if (start.line === end.line) {
      const line = lines[start.line] ?? '';
      lines[start.line] =
        line.slice(0, start.character) +
        edit.newText +
        line.slice(end.character);
    } else {
      const startLine = lines[start.line] ?? '';
      const endLine = lines[end.line] ?? '';
      const replacement =
        startLine.slice(0, start.character) +
        edit.newText +
        endLine.slice(end.character);
      lines.splice(
        start.line,
        end.line - start.line + 1,
        ...replacement.split('\n'),
      );
    }
  }

  return lines.join('\n');
}

/** Flatten a WorkspaceEdit's text edits into a Map<uri, TextEdit[]>. */
export function flattenWorkspaceTextEdits(
  edit: WorkspaceEdit,
): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>();
  const push = (uri: string, edits: readonly TextEdit[]) => {
    if (edits.length === 0) return;
    const previous = out.get(uri);
    if (previous) previous.push(...edits);
    else out.set(uri, [...edits]);
  };

  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) push(uri, edits);
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if (!('textDocument' in change)) continue;
      const textDocumentEdit = change;
      push(
        textDocumentEdit.textDocument.uri,
        textDocumentEdit.edits.filter(
          (candidate): candidate is TextEdit =>
            'range' in candidate && 'newText' in candidate,
        ),
      );
    }
  }
  return out;
}

/**
 * Write `content` to `filePath` atomically: a temp file in the same directory is
 * renamed over the target, so a reader never observes a half-written file and a
 * crash mid-write leaves the original intact.
 */
async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, content, 'utf-8');
    // Preserve the original mode so the swap does not reset file permissions.
    try {
      const stat = await fs.stat(filePath);
      await fs.chmod(tempPath, stat.mode);
    } catch {
      // Target does not exist yet; the default mode is correct.
    }
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** Apply text edits to a file, atomically. */
export async function applyTextEditsToFile(
  filePath: string,
  edits: readonly TextEdit[],
): Promise<void> {
  const content = await fs.readFile(filePath, 'utf-8');
  await writeFileAtomic(filePath, applyTextEditsToString(content, edits));
}

/** One filesystem mutation actually performed by {@link applyWorkspaceEditToDisk}. */
export type ExecutedWorkspaceChange =
  | { kind: 'edit'; uri: string }
  | { kind: 'create'; uri: string }
  | { kind: 'rename'; oldUri: string; newUri: string }
  | { kind: 'delete'; uri: string };

/** What {@link applyWorkspaceEditToDisk} did. */
export interface WorkspaceEditResult {
  applied: string[];
  /** Ops that mutated the filesystem; skipped idempotent ops are excluded. */
  executed: ExecutedWorkspaceChange[];
}

type WorkspaceEditOp =
  | { kind: 'text'; uri: string; edits: TextEdit[] }
  | { kind: 'create'; uri: string; options?: CreateFileOptions }
  | {
      kind: 'rename';
      oldUri: string;
      newUri: string;
      options?: RenameFileOptions;
    }
  | { kind: 'delete'; uri: string; options?: DeleteFileOptions };

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = error['code'];
  return typeof code === 'string' ? code : undefined;
}

/**
 * Flatten documentChanges into an ordered op list. Text edits accumulate per
 * URI and are flushed before any resource op touching that URI (or, for folder
 * renames/deletes, any descendant) so every op observes the correct prior state.
 */
function planDocumentChanges(
  documentChanges: readonly DocumentChange[],
): WorkspaceEditOp[] {
  const ops: WorkspaceEditOp[] = [];
  const pending = new Map<string, TextEdit[]>();

  const flushUri = (uri: string) => {
    const edits = pending.get(uri);
    if (!edits) return;
    pending.delete(uri);
    ops.push({ kind: 'text', uri, edits });
  };

  const flushSubtree = (uri: string) => {
    const prefix = uri.endsWith('/') ? uri : `${uri}/`;
    for (const candidate of Array.from(pending.keys())) {
      if (candidate === uri || candidate.startsWith(prefix))
        flushUri(candidate);
    }
  };

  for (const change of documentChanges) {
    if ('textDocument' in change && change.textDocument && 'edits' in change) {
      const textDocumentEdit = change;
      const uri = textDocumentEdit.textDocument.uri;
      const textEdits = textDocumentEdit.edits.filter(
        (candidate): candidate is TextEdit =>
          'range' in candidate && 'newText' in candidate,
      );
      if (textEdits.length === 0) continue;
      const previous = pending.get(uri);
      if (previous) previous.push(...textEdits);
      else pending.set(uri, [...textEdits]);
      continue;
    }
    if (!('kind' in change) || !change.kind) continue;

    if (change.kind === 'create') {
      const createOp = change;
      flushUri(createOp.uri);
      ops.push({
        kind: 'create',
        uri: createOp.uri,
        options: createOp.options,
      });
    } else if (change.kind === 'rename') {
      const renameOp = change;
      // Per LSP §3.16.2 documentChanges apply in declared order. Flush both the
      // source subtree (prior edits land before the move) and the destination
      // subtree (prior edits land on whatever exists at newUri).
      flushSubtree(renameOp.oldUri);
      flushSubtree(renameOp.newUri);
      ops.push({
        kind: 'rename',
        oldUri: renameOp.oldUri,
        newUri: renameOp.newUri,
        options: renameOp.options,
      });
    } else {
      const deleteOp = change;
      flushSubtree(deleteOp.uri);
      ops.push({
        kind: 'delete',
        uri: deleteOp.uri,
        options: deleteOp.options,
      });
    }
  }

  for (const uri of Array.from(pending.keys())) flushUri(uri);
  return ops;
}

/**
 * Apply a WorkspaceEdit to the real filesystem.
 *
 * Every text-edit batch is overlap-validated before anything is written, so a
 * conflict throws with the workspace untouched. `onExecuted` fires after each
 * mutation: when a later op throws, the returned result is lost but the callback
 * has already reported the executed prefix that reconciliation needs.
 */
export async function applyWorkspaceEditToDisk(
  edit: WorkspaceEdit,
  opts?: {
    cwd?: string;
    onExecuted?: (change: ExecutedWorkspaceChange) => void;
  },
): Promise<WorkspaceEditResult> {
  const cwd = opts?.cwd ?? process.cwd();
  const applied: string[] = [];
  const executed: ExecutedWorkspaceChange[] = [];
  const record = (change: ExecutedWorkspaceChange) => {
    executed.push(change);
    opts?.onExecuted?.(change);
  };
  const display = (filePath: string) => {
    const relative = path.relative(cwd, filePath);
    return relative && !relative.startsWith('..') ? relative : filePath;
  };

  if (edit.documentChanges) {
    const ops = planDocumentChanges(edit.documentChanges);
    for (const op of ops) {
      if (op.kind === 'text') sortAndValidateTextEdits(op.edits);
    }

    for (const op of ops) {
      if (op.kind === 'text') {
        const filePath = uriToFile(op.uri);
        await applyTextEditsToFile(filePath, op.edits);
        applied.push(
          `Applied ${op.edits.length} edit(s) to ${display(filePath)}`,
        );
        record({ kind: 'edit', uri: op.uri });
        continue;
      }

      if (op.kind === 'create') {
        const filePath = uriToFile(op.uri);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        try {
          if (op.options?.overwrite) {
            await writeFileAtomic(filePath, '');
          } else {
            const handle = await fs.open(filePath, 'wx');
            await handle.close();
          }
        } catch (error) {
          if (
            op.options?.ignoreIfExists &&
            !op.options.overwrite &&
            errorCode(error) === 'EEXIST'
          ) {
            continue;
          }
          throw error;
        }
        applied.push(`Created ${display(filePath)}`);
        record({ kind: 'create', uri: op.uri });
        continue;
      }

      if (op.kind === 'rename') {
        const oldPath = uriToFile(op.oldUri);
        const newPath = uriToFile(op.newUri);
        if (oldPath === newPath) {
          applied.push(`Renamed ${display(oldPath)} (case-only change)`);
          continue;
        }
        await fs.mkdir(path.dirname(newPath), { recursive: true });
        let exists = true;
        try {
          await fs.lstat(newPath);
        } catch (error) {
          if (errorCode(error) === 'ENOENT') exists = false;
          else throw error;
        }
        if (exists) {
          if (!op.options?.overwrite) {
            if (op.options?.ignoreIfExists) continue;
            throw new LspEditError(
              `rename target already exists: ${display(newPath)}`,
            );
          }
          // Displace the destination into a sibling temp dir (same filesystem,
          // so the moves stay atomic) instead of deleting it, so a failed
          // rename can restore it.
          const holdDir = await fs.mkdtemp(
            path.join(path.dirname(newPath), '.lsp-displaced-'),
          );
          const holdFile = path.join(holdDir, path.basename(newPath));
          try {
            await fs.rename(newPath, holdFile);
          } catch (error) {
            await fs
              .rm(holdDir, { recursive: true, force: true })
              .catch(() => {});
            throw error;
          }
          try {
            await fs.rename(oldPath, newPath);
          } catch (error) {
            await fs
              .rename(holdFile, newPath)
              .catch(() => record({ kind: 'delete', uri: op.newUri }));
            await fs
              .rm(holdDir, { recursive: true, force: true })
              .catch(() => {});
            throw error;
          }
          await fs
            .rm(holdDir, { recursive: true, force: true })
            .catch(() => {});
        } else {
          await fs.rename(oldPath, newPath);
        }
        applied.push(`Renamed ${display(oldPath)} → ${display(newPath)}`);
        record({ kind: 'rename', oldUri: op.oldUri, newUri: op.newUri });
        continue;
      }

      const filePath = uriToFile(op.uri);
      try {
        const stat = await fs.lstat(filePath);
        if (
          stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          !op.options?.recursive
        ) {
          await fs.rmdir(filePath);
        } else {
          await fs.rm(filePath, { recursive: op.options?.recursive ?? false });
        }
      } catch (error) {
        if (op.options?.ignoreIfNotExists && errorCode(error) === 'ENOENT')
          continue;
        throw error;
      }
      applied.push(`Deleted ${display(filePath)}`);
      record({ kind: 'delete', uri: op.uri });
    }

    return { applied, executed };
  }

  // Legacy changes-map path: validate every file's edits before writing any.
  if (edit.changes) {
    for (const edits of Object.values(edit.changes)) {
      sortAndValidateTextEdits(edits);
    }
    for (const [uri, textEdits] of Object.entries(edit.changes)) {
      if (textEdits.length === 0) continue;
      const filePath = uriToFile(uri);
      await applyTextEditsToFile(filePath, textEdits);
      applied.push(
        `Applied ${textEdits.length} edit(s) to ${display(filePath)}`,
      );
      record({ kind: 'edit', uri });
    }
  }

  return { applied, executed };
}

// =============================================================================
// Rename
// =============================================================================

/** A reference file plus the text edits a rename computed for it. */
export interface RenameReferenceEdit {
  filePath: string;
  edits: TextEdit[];
}

/** The client surface {@link applyEditsThenRename} needs. */
export interface RenameClientLike {
  supportsWillRenameFiles(): boolean;
  request<T>(
    method: string,
    params: unknown,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T>;
  notify(method: string, params: unknown): Promise<void>;
}

export interface RenameResult {
  /** URIs whose text edits were applied, in application order. */
  editedUris: string[];
  /** True when the server advertised `workspace/willRenameFiles`. */
  consultedServer: boolean;
  /** The server's `willRenameFiles` edits, when it returned any. */
  serverEdits?: WorkspaceEdit;
}

/**
 * Coalesce every reference edit per URI (caller-supplied plus any the server
 * returned from `workspace/willRenameFiles`), write them, then move
 * `source` → `dest` and announce the move with `workspace/didRenameFiles`.
 *
 * Hard-failure rule: when the server supports `workspace/willRenameFiles` and
 * the request errors, the rename aborts before touching the filesystem. A
 * failed move after edits were written restores every snapshot first, so the
 * source, destination, and all reference files are left exactly as they were.
 */
export async function applyEditsThenRename(
  client: RenameClientLike,
  references: readonly RenameReferenceEdit[],
  source: string,
  dest: string,
  opts?: { signal?: AbortSignal },
): Promise<RenameResult> {
  const sourceUri = fileToUri(source);
  const destUri = fileToUri(dest);

  const consultedServer = client.supportsWillRenameFiles();
  let serverEdits: WorkspaceEdit | undefined;
  if (consultedServer) {
    // Throws propagate untouched: nothing on disk has been modified yet.
    serverEdits =
      (await client.request<WorkspaceEdit | null>(
        'workspace/willRenameFiles',
        { files: [{ oldUri: sourceUri, newUri: destUri }] },
        { signal: opts?.signal },
      )) ?? undefined;
  }

  // Coalesce per URI so a file mentioned by both sources is edited once, with
  // its edits validated together.
  const byUri = new Map<string, TextEdit[]>();
  for (const reference of references) {
    const existing = byUri.get(reference.filePath);
    if (existing) existing.push(...reference.edits);
    else byUri.set(reference.filePath, [...reference.edits]);
  }
  if (serverEdits) {
    for (const [uri, edits] of flattenWorkspaceTextEdits(serverEdits)) {
      const filePath = uriToFile(uri);
      const existing = byUri.get(filePath);
      if (existing) existing.push(...edits);
      else byUri.set(filePath, [...edits]);
    }
  }

  const targets = Array.from(byUri.entries()).filter(
    ([, edits]) => edits.length > 0,
  );
  for (const [, edits] of targets) sortAndValidateTextEdits(edits);

  const backups: Array<{ filePath: string; original: string }> = [];
  const editedUris: string[] = [];
  try {
    for (const [filePath, edits] of targets) {
      backups.push({
        filePath,
        original: await fs.readFile(filePath, 'utf-8'),
      });
      await applyTextEditsToFile(filePath, edits);
      editedUris.push(fileToUri(filePath));
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(source, dest);
  } catch (error) {
    await Promise.all(
      backups.map(({ filePath, original }) =>
        writeFileAtomic(filePath, original),
      ),
    );
    throw error;
  }

  await client.notify('workspace/didRenameFiles', {
    files: [{ oldUri: sourceUri, newUri: destUri }],
  });

  return {
    editedUris,
    consultedServer,
    ...(serverEdits ? { serverEdits } : {}),
  };
}

/**
 * Stable identity for a set of edits, used to collapse duplicate diagnostics and
 * rename payloads that describe the same change.
 */
export function editsFingerprint(edits: readonly TextEdit[]): string {
  const hash = createHash('sha256');
  for (const edit of edits) {
    hash.update(
      `${edit.range.start.line}:${edit.range.start.character}-` +
        `${edit.range.end.line}:${edit.range.end.character}:${edit.newText}`,
    );
  }
  return hash.digest('hex').slice(0, 16);
}
