/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  SlashCommandActionReturn,
  CommandContext,
} from './types.js';
import { CommandKind } from './types.js';
import type { SshProfile, SshProfileService } from '@google/gemini-cli-core';

/**
 * Lists saved servers and selects the one the agent should work on.
 *
 * Selecting is what makes the rest of the session simpler: `ssh_exec` then
 * needs no profile argument, and the transcript shows which host each command
 * ran on. No password is ever printed, only whether one is available.
 */
export const sshCommand: SlashCommand = {
  name: 'ssh',
  description: 'Show saved servers, and connect the agent to one',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const profiles: SshProfileService | undefined =
      context.services.agentContext?.config.getSshProfiles();
    if (!profiles) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'SSH profiles are unavailable in this session.',
      };
    }

    const saved = profiles.list();
    if (saved.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content:
          'No servers saved yet. Run /ssh-add to store one (host, user, port and password).',
      };
    }

    const requested = args.trim();
    if (!requested) {
      return {
        type: 'message',
        messageType: 'info',
        content: describeProfiles(saved, profiles),
      };
    }

    try {
      const profile = profiles.activate(requested);
      return {
        type: 'message',
        messageType: 'info',
        content:
          `Connected: ${profile.user}@${profile.host}:${profile.port}.\n` +
          'The agent can now reach this host with ssh_exec; you will see every ' +
          'command and its output as it runs. ' +
          'Run /ssh to switch hosts.',
      };
    } catch (error) {
      const known = saved.map((p) => p.name).join(', ');
      return {
        type: 'message',
        messageType: 'error',
        content:
          error instanceof Error
            ? `${error.message}\nSaved: ${known}`
            : String(error),
      };
    }
  },
};

function describeProfiles(
  saved: readonly SshProfile[],
  profiles: SshProfileService,
): string {
  const active = profiles.getActiveProfile()?.name;
  const lines = saved.map((profile) => {
    const marker = profile.name === active ? '*' : ' ';
    // "password" here means "authenticate with a password or ssh-agent", not
    // "a password is stored": whether one exists is a keychain question this
    // listing deliberately does not ask, because it would cost a lookup per
    // profile. `sudo` is the flag the user actually needs to see, because it
    // decides whether the agent may elevate on that host at all.
    const auth = profile.identityFile
      ? 'key'
      : profile.hasSudoPassword
        ? 'password, sudo'
        : 'password';
    return `${marker} ${profile.name.padEnd(16)} ${profile.user}@${profile.host}:${profile.port}  (${auth})`;
  });
  return [
    'Saved servers (* = active):',
    ...lines,
    '',
    'Run /ssh <name> to point the agent at one.',
  ].join('\n');
}

export const sshCommandAction = sshCommand.action;
