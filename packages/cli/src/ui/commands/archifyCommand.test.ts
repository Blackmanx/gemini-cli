/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  makeFakeConfig,
  type Config,
  type SkillDefinition,
} from '@google/gemini-cli-core';
import { archifyCommand } from './archifyCommand.js';
import type { CommandContext, SlashCommandActionReturn } from './types.js';

function ctx(config: Config): CommandContext {
  return {
    services: { agentContext: { config } },
  } as unknown as CommandContext;
}

function seedArchify(config: Config, overrides: Partial<SkillDefinition> = {}) {
  config.getSkillManager().addSkills([
    {
      name: 'archify',
      description: 'Create diagrams.',
      location: '/skills/archify/SKILL.md',
      body: 'body',
      ...overrides,
    },
  ]);
}

async function run(
  config: Config | undefined,
  args: string,
): Promise<SlashCommandActionReturn> {
  const context = config
    ? ctx(config)
    : ({ services: {} } as unknown as CommandContext);
  const result = await archifyCommand.action!(context, args);
  return result as SlashCommandActionReturn;
}

function content(result: SlashCommandActionReturn): string {
  expect(result).toHaveProperty('type', 'message');
  return (result as { content: string }).content;
}

describe('archifyCommand', () => {
  it('errors when there is no active session', async () => {
    const text = content(await run(undefined, 'the login flow'));
    expect(text).toContain('No active session');
  });

  it('errors when the archify skill is not discovered', async () => {
    const text = content(await run(makeFakeConfig(), 'the login flow'));
    expect(text).toContain('not available');
    expect(text).toContain('/skills reload');
  });

  it('errors when the skill is disabled and names the fix', async () => {
    const config = makeFakeConfig();
    seedArchify(config, { disabled: true });
    const text = content(await run(config, 'the login flow'));
    expect(text).toContain('disabled');
    expect(text).toContain('/skills enable archify');
  });

  it('maps the current workspace when no request is given', async () => {
    const config = makeFakeConfig();
    seedArchify(config);
    const result = await run(config, '   ');
    expect(result).toHaveProperty('type', 'submit_prompt');
    const prompt = (result as { content: string }).content;
    expect(prompt).toContain('activate_skill');
    expect(prompt).toContain('CURRENT WORKSPACE');
    expect(prompt).toContain('`architecture` diagram');
  });

  it('instructs flat .archify delivery with a stable mode-named HTML', async () => {
    const config = makeFakeConfig();
    seedArchify(config);
    const result = await run(config, 'the login flow');
    expect(result).toHaveProperty('type', 'submit_prompt');
    const prompt = (result as { content: string }).content;
    expect(prompt).toContain('.archify/candidate.json');
    expect(prompt).toContain('architecture.html');
    expect(prompt).toContain('subdirectory');
    expect(prompt).toContain('overwrites it');
    expect(prompt).toContain('leaves the previous file untouched');
  });

  it('submits a prompt that forces activation and passes the request', async () => {
    const config = makeFakeConfig();
    seedArchify(config);
    const result = await run(config, 'the request path of this API');
    expect(result).toHaveProperty('type', 'submit_prompt');
    const prompt = (result as { content: string }).content;
    expect(prompt).toContain('activate_skill');
    expect(prompt).toContain('`archify`');
    expect(prompt).toContain('the request path of this API');
    expect(prompt).toContain('finalize');
  });
});
