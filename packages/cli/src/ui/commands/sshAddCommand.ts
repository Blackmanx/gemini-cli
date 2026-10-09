/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import prompts from 'prompts';
import type {
  SlashCommand,
  SlashCommandActionReturn,
  CommandContext,
} from './types.js';
import { CommandKind } from './types.js';
import {
  DEFAULT_SSH_PORT,
  isValidSshProfileName,
  type SshProfile,
  type SshProfileService,
} from '@google/gemini-cli-core';

/** The shape the wizard collects before it is validated and stored. */
interface SshAddAnswers {
  name: string;
  host: string;
  user: string;
  port: string;
  password?: string;
  sudoPassword?: string;
  keyPath?: string;
}

function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `"${raw}" is not a valid port. Expected a number from 1 to 65535.`,
    );
  }
  return port;
}

/**
 * Stores a connection the agent can later reach.
 *
 * The passwords go to the OS keychain, never to `settings.json`: a settings
 * file gets synced, backed up and sometimes committed, and an SSH password
 * does not belong in any of those. A profile with no sudo password is the
 * normal case, and it is what makes `sudo` unavailable to the agent on that
 * host rather than merely discouraged.
 */
export const sshAddCommand: SlashCommand = {
  name: 'ssh-add',
  description:
    'Save a server connection the agent can use (host, user, port, password)',
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

    const existing = profiles.get(args.trim());
    const answers = await prompts(
      [
        {
          type: existing ? 'text' : 'text',
          name: 'name',
          message: 'Profile name',
          initial: existing?.name ?? args.trim(),
          validate: (value: string) => {
            if (!isValidSshProfileName(value)) {
              return 'Use letters, digits, dot, dash or underscore (max 64).';
            }
            const clash = profiles.get(value);
            return clash && value !== existing?.name
              ? `A profile named "${value}" already exists. Choose another name.`
              : true;
          },
        },
        {
          type: 'text',
          name: 'host',
          message: 'Host or IP address',
          initial: existing?.host,
          validate: (value: string) =>
            value.trim() === '' ? 'A host is required.' : true,
        },
        {
          type: 'text',
          name: 'user',
          message: 'SSH user',
          initial: existing?.user,
          validate: (value: string) =>
            value.trim() === '' ? 'A user is required.' : true,
        },
        {
          type: 'text',
          name: 'port',
          message: 'Port',
          initial: String(existing?.port ?? DEFAULT_SSH_PORT),
          validate: (value: string) => {
            try {
              parsePort(value);
              return true;
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          },
        },
        {
          type: 'text',
          name: 'keyPath',
          message: 'Private key path (blank for password auth or ssh-agent)',
          initial: existing?.identityFile,
        },
        {
          type: (prev) => (prev ? null : 'password'),
          name: 'password',
          message: 'SSH password (stored in your OS keychain)',
        },
        {
          type: 'password',
          name: 'sudoPassword',
          message:
            'sudo password (leave blank to forbid sudo for the agent on this host)',
        },
      ],
      {
        onCancel: () => {
          throw new Error('Cancelled.');
        },
      },
    );

    const collected = answers as Partial<SshAddAnswers>;
    if (!collected.name || !collected.host || !collected.user) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Cancelled; nothing was saved.',
      };
    }

    try {
      const profile: SshProfile = profiles.save({
        name: collected.name,
        host: collected.host,
        user: collected.user,
        port: parsePort(collected.port ?? String(DEFAULT_SSH_PORT)),
        ...(collected.keyPath?.trim()
          ? { identityFile: collected.keyPath }
          : {}),
      });

      // Only overwrite a stored password the user actually typed. An
      // unanswered prompt means "leave what is there", which is what makes
      // re-running /ssh-add to fix the host safe.
      await profiles.setPasswords(profile.name, {
        password: collected.password,
        sudoPassword: collected.sudoPassword,
      });

      const sudo =
        collected.sudoPassword === undefined
          ? existing?.hasSudoPassword
            ? 'sudo unchanged'
            : 'sudo disabled'
          : collected.sudoPassword
            ? 'sudo enabled'
            : 'sudo disabled';

      return {
        type: 'message',
        messageType: 'info',
        content:
          `Saved "${profile.name}" → ${profile.user}@${profile.host}:${profile.port} (${sudo}).\n` +
          `Run /ssh ${profile.name} to connect.`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

export const sshAddCommandAction = sshAddCommand.action;
