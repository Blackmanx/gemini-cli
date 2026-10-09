/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createElement } from 'react';
import type {
  SlashCommand,
  SlashCommandActionReturn,
  CommandContext,
} from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import {
  SshAddDialog,
  type SshAddAnswers,
} from '../components/SshAddDialog.js';
import type { SshProfileService } from '@google/gemini-cli-core';

/**
 * Stores a connection the agent can later reach.
 *
 * The wizard is an Ink dialog rather than a `prompts` session: `prompts` puts
 * the terminal into raw mode and writes directly to stdout, which fights this
 * TUI's renderer and deadlocks the CLI the moment the command runs.
 *
 * The passwords go to the OS keychain, never to `settings.json`: a settings
 * file gets synced, backed up and sometimes committed, and an SSH password
 * belongs in none of those. A profile with no sudo password is the normal
 * case, and it is what makes `sudo` unavailable to the agent on that host
 * rather than merely discouraged.
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

    const named = args.trim();
    const existing = named ? profiles.get(named) : null;

    return {
      type: 'custom_dialog',
      component: createElement(SshAddDialog, {
        existingNames: profiles
          .list()
          .filter((profile) => profile.name !== existing?.name)
          .map((profile) => profile.name),
        ...(existing && {
          initial: {
            name: existing.name,
            host: existing.host,
            user: existing.user,
            port: String(existing.port),
            ...(existing.identityFile && {
              identityFile: existing.identityFile,
            }),
          },
        }),
        onSubmit: (answers: SshAddAnswers | null) => {
          context.ui.removeComponent();
          void persist(context, profiles, existing, answers);
        },
      }),
    };
  },
};

/**
 * Writes the collected answers, then reports the outcome as history.
 *
 * Runs detached from the dialog: the submission callback cannot await, and
 * awaiting here would leave the dialog on screen until the keychain write
 * finished.
 */
async function persist(
  context: CommandContext,
  profiles: SshProfileService,
  existing: { name: string; hasSudoPassword?: boolean } | null,
  answers: SshAddAnswers | null,
): Promise<void> {
  if (!answers) {
    context.ui.addItem({
      type: MessageType.INFO,
      text: 'Cancelled; nothing was saved.',
    });
    return;
  }

  try {
    const profile = profiles.save({
      name: answers.name,
      host: answers.host,
      user: answers.user,
      port: answers.port,
      ...(answers.identityFile && { identityFile: answers.identityFile }),
    });

    // Only the secrets the operator actually typed are written: leaving a
    // field blank means "keep what is stored", which is what makes re-running
    // /ssh-add to fix a host safe.
    await profiles.setPasswords(profile.name, {
      password: answers.password,
      sudoPassword: answers.sudoPassword,
    });

    const sudo =
      answers.sudoPassword === undefined
        ? existing?.hasSudoPassword
          ? 'sudo unchanged'
          : 'sudo disabled'
        : 'sudo enabled';

    context.ui.addItem({
      type: MessageType.INFO,
      text:
        `Saved "${profile.name}" → ${profile.user}@${profile.host}:${profile.port} (${sudo}).\n` +
        `Run /ssh ${profile.name} to connect.`,
    });
  } catch (error) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: error instanceof Error ? error.message : String(error),
    });
  }
}
