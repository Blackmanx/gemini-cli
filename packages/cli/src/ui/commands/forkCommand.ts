/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  childrenOf,
  forkSessionFile,
  listSessions,
} from '@google/gemini-cli-core';
import { randomUUID } from 'node:crypto';
import { CommandKind, type SlashCommand } from './types.js';

/**
 * `/fork` — branch this conversation, keeping the history.
 *
 * Ported from omp's `/fork`. The gap it fills: once a conversation has gone
 * somewhere you do not want to be in, the alternatives are `/clear` (lose
 * everything) or rewind (lose what came after). Neither lets you KEEP the
 * conversation and try the other direction.
 *
 * `/fork` copies the recorded session into a new file whose header names this
 * one as its parent, so the set of sessions becomes a tree rather than a pile.
 */
export const forkCommand: SlashCommand = {
  name: 'fork',
  description: 'Branch this conversation, keeping its history',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No active session to fork.',
      };
    }
    const dir = config.storage.getProjectTempDir();
    if (!dir) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No project directory to fork into.',
      };
    }
    // The session being forked is whichever recorded file was written last:
    // the running one.
    const sessions = listSessions(dir);
    if (sessions.length === 0) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No recorded session to fork yet.',
      };
    }
    const current = sessions[0];
    const newId = randomUUID();
    let result;
    try {
      result = forkSessionFile(current.file, dir, newId);
    } catch (err) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          err instanceof Error
            ? `Could not fork the session: ${err.message}`
            : 'Could not fork the session.',
      };
    }
    return {
      type: 'message',
      messageType: 'info',
      content:
        `Forked ${result.messageCount} message(s) into session ${newId}.\n` +
        `Run /tree to see it, or /chat resume to switch to it.`,
    };
  },
};

/**
 * `/tree` — the session tree, as a view of the parent links.
 *
 * The tree is derived from `parentSessionId`, not stored separately, so
 * sessions recorded before forking existed still appear, at the root.
 */
export const treeCommand: SlashCommand = {
  name: 'tree',
  altNames: ['sessions'],
  description: 'Show the session tree for this project',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No active session.',
      };
    }
    const dir = config.storage.getProjectTempDir();
    if (!dir) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No project directory.',
      };
    }
    const nodes = listSessions(dir);
    if (nodes.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'No recorded sessions yet.',
      };
    }
    // A parent that is not itself present in the listing is a fork of a
    // session that was deleted; such a node is drawn at the root rather than
    // being dropped, because hiding it would lose a real conversation.
    const present = new Set(nodes.map((n) => n.sessionId));
    const roots = nodes.filter(
      (n) => n.parentSessionId === undefined || !present.has(n.parentSessionId),
    );
    const lines: string[] = [];
    const walk = (id: string, depth: number) => {
      const node = nodes.find((n) => n.sessionId === id);
      if (!node) return;
      const when = node.startedAt
        ? node.startedAt.replace('T', ' ').slice(0, 19)
        : '';
      lines.push(
        `${'  '.repeat(depth)}${depth === 0 ? '' : '└─ '}${short(id)}  ` +
          `${node.messageCount} msg  ${when}`,
      );
      for (const child of childrenOf(nodes, id)) {
        walk(child.sessionId, depth + 1);
      }
    };
    for (const root of roots) {
      walk(root.sessionId, 0);
    }
    return {
      type: 'message',
      messageType: 'info',
      content: `Sessions (${nodes.length}):\n${lines.join('\n')}`,
    };
  },
};

/** A session id short enough to read in a tree. */
function short(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
