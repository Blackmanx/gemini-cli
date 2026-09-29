/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from '../utils/markdownUtils.js';
import { isStringProperty } from '../utils/typeGuards.js';

/**
 * Session forking.
 *
 * Ported from omp's `SessionManager.fork()` and the `/fork` command.
 * Branching is the most-missed piece of session UX: once a conversation has
 * gone somewhere you do not want to be in, the choice is `/clear` (lose
 * everything) or `/rewind` (go backwards, losing what came after). Neither
 * lets you KEEP the conversation and try the other direction.
 *
 * The new file records where it came from, so the set of sessions becomes a
 * tree rather than a pile. The field is additive and optional: a session
 * written before this existed still loads.
 */

/** The header record of a recorded session. */
export interface SessionHeader {
  sessionId: string;
  startTime?: string;
  parentSessionId?: string;
}

/**
 * The header line of a recorded session: the record that carries `sessionId`.
 *
 * A session file is JSONL, so the header is identified by the discriminator
 * rather than by position — a crashed session can truncate the first line, and
 * a forked file has extra fields.
 */
function isSessionHeader(value: unknown): value is SessionHeader {
  return isStringProperty(value, 'sessionId');
}

/** Prefix of a recorded session file, matching the recorder. */
export const SESSION_FILE_PREFIX = 'session-';

/** Recorded in a forked session's header to say what it forked from. */
export const PARENT_SESSION_FIELD = 'parentSessionId';

export interface ForkResult {
  /** Absolute path of the new session file. */
  path: string;
  /** The session it was forked from, or `undefined` at the root. */
  parentSessionId: string | undefined;
  /** How many messages were carried over. */
  messageCount: number;
}

/**
 * Copy a recorded session into a new file whose header names the parent.
 *
 * The whole conversation is carried over: a fork that started from an empty
 * history would not be a fork, it would be a new session with a misleading
 * name.
 */
export function forkSessionFile(
  sourceFile: string,
  targetDir: string,
  newSessionId: string,
): ForkResult {
  const raw = fs.readFileSync(sourceFile, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim() !== '');

  let parentSessionId: string | undefined;
  let messageCount = 0;
  const out: string[] = [];

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated final line from a crashed session is dropped rather than
      // failing the fork outright; a fork is a recovery tool.
      continue;
    }
    if (isSessionHeader(parsed)) {
      // The metadata header: rewrite it for the new session and record the
      // parent, so a later fork of THIS one is still traceable.
      parentSessionId = parsed.sessionId;
      out.push(
        JSON.stringify({
          ...parsed,
          sessionId: newSessionId,
          [PARENT_SESSION_FIELD]: parentSessionId,
          startTime: new Date().toISOString(),
        }),
      );
      continue;
    }
    if (isRecord(parsed) && Array.isArray(parsed['messages'])) {
      messageCount = parsed['messages'].length;
    }
    out.push(line);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const fileName = `${SESSION_FILE_PREFIX}${newSessionId}.jsonl`;
  const target = path.join(targetDir, fileName);
  // `wx` so an existing session is never silently overwritten: losing a
  // conversation to a name collision is not recoverable.
  const fd = fs.openSync(target, 'wx');
  try {
    fs.writeFileSync(fd, `${out.join('\n')}\n`, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  return { path: target, parentSessionId, messageCount };
}

/** The parent of a recorded session, when it was forked. */
export function parentSessionId(file: string): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isSessionHeader(parsed)) {
      return parsed[PARENT_SESSION_FIELD];
    }
  }
  return undefined;
}

export interface SessionNode {
  sessionId: string;
  file: string;
  parentSessionId: string | undefined;
  /** ISO timestamp from the header, when present. */
  startedAt: string | undefined;
  /** Messages carried in the file. */
  messageCount: number;
}

/** Read one recorded session's identity. */
export function readSessionNode(file: string, sessionId: string): SessionNode {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {
      sessionId,
      file,
      parentSessionId: undefined,
      startedAt: undefined,
      messageCount: 0,
    };
  }
  let parentSessionId: string | undefined;
  let startedAt: string | undefined;
  let messageCount = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isSessionHeader(parsed)) {
      parentSessionId = parsed[PARENT_SESSION_FIELD];
      startedAt = parsed.startTime;
    }
    if (isRecord(parsed) && Array.isArray(parsed['messages'])) {
      messageCount = parsed['messages'].length;
    }
  }
  return { sessionId, file, parentSessionId, startedAt, messageCount };
}

/**
 * Every recorded session under `dir`, as a flat list with parent links.
 *
 * The tree view is built from those links rather than stored, so sessions
 * recorded before forking existed still appear — at the root.
 */
export function listSessions(dir: string): SessionNode[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const nodes: SessionNode[] = [];
  for (const name of names) {
    if (!name.startsWith(SESSION_FILE_PREFIX) || !name.endsWith('.jsonl')) {
      continue;
    }
    const sessionId = name.slice(SESSION_FILE_PREFIX.length, -'.jsonl'.length);
    nodes.push(readSessionNode(path.join(dir, name), sessionId));
  }
  return nodes.sort((a, b) =>
    (b.startedAt ?? '').localeCompare(a.startedAt ?? ''),
  );
}

/** Children of `sessionId`, direct only. */
export function childrenOf(
  nodes: SessionNode[],
  sessionId: string,
): SessionNode[] {
  return nodes.filter((n) => n.parentSessionId === sessionId);
}
