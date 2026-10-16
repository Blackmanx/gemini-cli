/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import { MessageType, type HistoryItemExportSession } from '../types.js';
import { SessionSelector } from '../../utils/sessionUtils.js';
import { renderSessionMarkdown } from '../../utils/sessionMarkdown.js';

export const exportSessionCommand: SlashCommand = {
  name: 'export-session',
  description:
    'Export the current session to a file (.md for a readable Markdown transcript, .json for the raw session data)',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (
    context: CommandContext,
  ): Promise<SlashCommandActionReturn | void> => {
    const { ui } = context;
    const args = context.invocation?.args.trim();
    const sessionId = context.services.agentContext?.config.getSessionId();
    if (!sessionId) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No active session found to export.',
      };
    }

    if (ui.pendingItem) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Operation already in progress, please wait.',
        },
        Date.now(),
      );
      return;
    }

    const pendingMessage: HistoryItemExportSession = {
      type: MessageType.EXPORT_SESSION,
      exportSession: {
        isPending: true,
      },
    };

    try {
      ui.setPendingItem(pendingMessage);
      const storage = context.services.agentContext!.config.storage;
      const sessionSelector = new SessionSelector(storage);
      const { sessionData } = await sessionSelector.resolveSession(sessionId);

      // No path given: default to a timestamped Markdown transcript in the
      // working directory — the friendly, no-knowledge-required path.
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const targetPath = path.resolve(
        process.cwd(),
        args || `gemini-session-${stamp}.md`,
      );

      // Format follows the file extension: .md/.markdown renders a readable
      // transcript, anything else keeps the historical raw JSON dump.
      const payload = /\.(md|markdown)$/i.test(targetPath)
        ? renderSessionMarkdown(sessionData)
        : JSON.stringify(sessionData, null, 2);

      await fs.writeFile(targetPath, payload, 'utf-8');

      ui.addItem(
        {
          type: MessageType.EXPORT_SESSION,
          exportSession: {
            isPending: false,
            targetPath,
          },
        } as HistoryItemExportSession,
        Date.now(),
      );
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to export session: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    } finally {
      ui.setPendingItem(null);
    }
  },
};
