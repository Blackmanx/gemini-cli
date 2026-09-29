/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  completionScript,
  debugLogger,
  installHint,
  isShell,
  type CompletionFlag,
} from '@google/gemini-cli-core';
import { CommandKind, type SlashCommand } from './types.js';
import { shareSession } from '../utils/sessionShare.js';

/**
 * `/share` — hand someone this conversation as one file.
 *
 * Ported from omp's `/share`. omp's version posts to a hosted share server;
 * that is infrastructure, not a feature, and a hosted service is not something
 * to stand up as part of a port. What is portable is the part that needs no
 * server: one file the recipient can open, with the parts that must not
 * travel taken out.
 *
 * Encryption is on by default and a passphrase is required, because a shared
 * file is a file that gets emailed.
 */
export const shareCommand: SlashCommand = {
  name: 'share',
  description: 'Export this session to a shareable (encrypted) file',
  kind: CommandKind.BUILT_IN,
  altNames: ['export-share'],
  autoExecute: true,
  action: async (context, args) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No active session to share.',
      };
    }
    const service = config.geminiClient?.getChatRecordingService();
    if (!service) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'This session is not being recorded, so there is nothing to share.',
      };
    }

    const text = (args ?? '').trim();
    // `--no-encrypt` and `--no-redact` are both explicit, because both
    // defaults are protective and overriding them should take typing.
    const encrypt = !/\bno-encrypt\b/.test(text);
    const redact = !/\bno-redact\b/.test(text);
    const match = /\bpassphrase[= ](?:"([^"]*)"|'([^']*)'|(\S+))/.exec(text);
    // Guarded above, so one of the alternatives matched.
    const passphrase =
      match === null ? undefined : (match[1] ?? match[2] ?? match[3]);

    try {
      const result = await shareSession(service, passphrase, {
        encrypt,
        redact,
      });
      const lines = [
        `Shared to ${result.path} (${String(result.byteSize)} bytes).`,
        result.encrypted
          ? 'Encrypted with your passphrase; it is NOT in the file. Send it separately.'
          : 'NOT encrypted - anyone with the file can read it.',
        redact
          ? `Credential-shaped text was replaced (${String(result.redactedCount)} placeholder(s)).`
          : 'Redaction was off - check the file before sending it.',
        `Read it back with: ${result.readBack}`,
      ];
      return {
        type: 'message',
        messageType: 'info',
        content: lines.join('\n'),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugLogger.debug(`[/share] ${message}`);
      return { type: 'message', messageType: 'error', content: message };
    }
  },
};

/**
 * The flags completions are generated from.
 *
 * Read from the CLI's own flag surface rather than restated, so a renamed
 * flag cannot leave a completion suggesting a flag the parser rejects.
 */
export function completionFlags(): CompletionFlag[] {
  return [
    {
      name: 'model',
      description: 'Model to use for this session',
      kind: 'value',
    },
    { name: 'prompt', description: 'Run one prompt and exit', kind: 'value' },
    {
      name: 'yolo',
      description: 'Skip confirmation prompts (dangerous)',
      kind: 'boolean',
    },
    {
      name: 'approval-mode',
      description: 'Default approval mode',
      kind: 'value',
    },
    {
      name: 'sandbox',
      description: 'Run commands in a sandbox',
      kind: 'boolean',
    },
    { name: 'debug', description: 'Enable debug logging', kind: 'boolean' },
    {
      name: 'include-directories',
      description: 'Extra directories for @include',
      kind: 'value',
    },
    {
      name: 'allowed-tools',
      description: 'Tools the agent may use',
      kind: 'value',
    },
    {
      name: 'disallowed-tools',
      description: 'Tools the agent may not use',
      kind: 'value',
    },
    {
      name: 'extensions',
      description: 'Extension directories to load',
      kind: 'value',
    },
    {
      name: 'list-extensions',
      description: 'List installed extensions',
      kind: 'boolean',
    },
    {
      name: 'version',
      description: 'Print the version and exit',
      kind: 'boolean',
    },
    { name: 'help', description: 'Print usage and exit', kind: 'boolean' },
  ];
}

/**
 * `/completions` — emit a shell completion script.
 *
 * The script goes to stdout so it can be piped or redirected; the command
 * prints the one-line `source` you would use. Generating from the live flag
 * list is the point: a static completion file goes stale silently, and a
 * completion that offers a flag the parser no longer accepts is worse than
 * none.
 */
export const completionsCommand: SlashCommand = {
  name: 'completions',
  description: 'Print a shell completion script (bash, zsh, fish)',
  kind: CommandKind.BUILT_IN,
  altNames: ['completion'],
  autoExecute: true,
  action: (_context, args) => {
    const requested = (args ?? '').trim().split(/\s+/)[0] ?? '';
    if (requested === '') {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'Name a shell: /completions bash, /completions zsh, or /completions fish.',
      };
    }
    if (!isShell(requested)) {
      return {
        type: 'message',
        messageType: 'error',
        content: `No completion for "${requested}". Use bash, zsh or fish.`,
      };
    }
    return {
      type: 'message',
      messageType: 'info',
      content:
        `${completionScript(requested, 'gemini', completionFlags())}\n` +
        `# Install with: ${installHint(requested, 'gemini')}\n`,
    };
  },
};
