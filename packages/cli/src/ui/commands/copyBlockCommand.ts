/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { copyLastCodeBlock } from '../utils/copyLastCodeBlock.js';

export const copyBlockCommand: SlashCommand = {
  name: 'copy-block',
  description:
    'Copy the last code block from the model response, without fences (F5)',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context): Promise<SlashCommandActionReturn | void> => {
    const outcome = await copyLastCodeBlock(
      context.services.agentContext?.geminiClient?.getChat()?.getHistory(),
      context.services.settings.merged,
    );
    return {
      type: 'message',
      messageType: outcome.isError ? 'error' : 'info',
      content: outcome.message,
    };
  },
};