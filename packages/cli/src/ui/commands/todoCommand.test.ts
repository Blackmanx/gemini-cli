/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type React from 'react';
import { makeFakeConfig, type Config } from '@google/gemini-cli-core';
import { todoCommand } from './todoCommand.js';
import type { CommandContext, SlashCommandActionReturn } from './types.js';

function ctx(config: Config): CommandContext {
  return {
    services: { agentContext: { config } },
    ui: { removeComponent: vi.fn() },
  } as unknown as CommandContext;
}

function seed(config: Config) {
  config.getTodoRuntime().setPhases([
    {
      name: 'Setup',
      tasks: [
        { content: 'Install deps', status: 'pending' },
        { content: 'Scaffold app', status: 'pending' },
      ],
    },
    {
      name: 'Build',
      tasks: [{ content: 'Add API', status: 'pending' }],
    },
  ]);
}

async function run(
  config: Config,
  args: string,
): Promise<SlashCommandActionReturn> {
  const result = await todoCommand.action!(ctx(config), args);
  return result as SlashCommandActionReturn;
}

function content(result: SlashCommandActionReturn): string {
  expect(result).toHaveProperty('type', 'message');
  return (result as { content: string }).content;
}

describe('todoCommand', () => {
  it('view renders the board as markdown with phases and tasks', async () => {
    const config = makeFakeConfig();
    seed(config);
    const text = content(await run(config, ''));
    expect(text).toContain('# Setup');
    expect(text).toContain('Install deps');
    expect(text).toContain('# Build');
  });

  it('done marks a task completed and auto-advances the next to in_progress', async () => {
    const config = makeFakeConfig();
    seed(config);
    await run(config, 'done Install deps');
    const tasks = config.getTodoPhases()[0].tasks;
    expect(tasks[0]).toEqual({ content: 'Install deps', status: 'completed' });
    expect(tasks[1].status).toBe('in_progress');
  });

  it('resolves a unique substring when the task text is not verbatim', async () => {
    const config = makeFakeConfig();
    seed(config);
    await run(config, 'done deps');
    expect(config.getTodoPhases()[0].tasks[0].status).toBe('completed');
  });

  it('rejects an ambiguous task match instead of guessing', async () => {
    const config = makeFakeConfig();
    config.getTodoRuntime().setPhases([
      {
        name: 'W',
        tasks: [
          { content: 'fix login', status: 'pending' },
          { content: 'fix logout', status: 'pending' },
        ],
      },
    ]);
    const result = await run(config, 'done fix');
    expect(result).toHaveProperty('messageType', 'error');
    expect(content(result)).toContain('Ambiguous');
  });

  it('block records a normalized reason after --', async () => {
    const config = makeFakeConfig();
    seed(config);
    await run(config, 'block Install deps -- needs design');
    expect(config.getTodoPhases()[0].tasks[0]).toEqual({
      content: 'Install deps',
      status: 'blocked',
      blocker: 'needs design',
    });
  });

  it('rm clears a phase by name when the text is not a task', async () => {
    const config = makeFakeConfig();
    seed(config);
    await run(config, 'rm Build');
    expect(config.getTodoPhases()[1].tasks).toEqual([]);
  });

  it('edit returns a custom_dialog carrying the current markdown', async () => {
    const config = makeFakeConfig();
    seed(config);
    const result = await run(config, 'edit');
    expect(result).toHaveProperty('type', 'custom_dialog');
    const component = (
      result as {
        component: React.ReactElement<{
          markdown: string;
          onClose: () => void;
        }>;
      }
    ).component;
    expect(component.props.markdown).toContain('# Setup');
    expect(component.props.markdown).toContain('Install deps');
    expect(typeof component.props.onClose).toBe('function');
  });

  it('clear empties the whole board', async () => {
    const config = makeFakeConfig();
    seed(config);
    await run(config, 'clear');
    expect(config.getTodoPhases()).toEqual([]);
  });

  it('an unknown subcommand returns an error, not a crash', async () => {
    const config = makeFakeConfig();
    const result = await run(config, 'bogus thing');
    expect(result).toHaveProperty('messageType', 'error');
    expect(content(result)).toContain('Unknown subcommand');
  });
});
