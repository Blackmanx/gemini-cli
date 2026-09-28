/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

const RESPONSES = join(import.meta.dirname, 'omp-port-w9.responses');

describe('omp port: foreign config discovery', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  /**
   * The imported-rules block lives in the system instruction, which the
   * request telemetry does not record. GEMINI_WRITE_SYSTEM_MD makes the CLI
   * write the resolved prompt out, so the assertion reads what the model
   * actually saw rather than guessing from the conversation.
   *
   * It must go through `run`'s env, not the process env: the rig strips
   * GEMINI_* variables from children by design.
   */
  const systemPromptPath = (): string => join(rig.homeDir!, 'system.md');
  const systemPromptEnv = (): Record<string, string> => ({
    GEMINI_WRITE_SYSTEM_MD: systemPromptPath(),
  });

  afterEach(async () => {
    await rig.cleanup();
  });

  it('puts another agent’s rules into the prompt, split by scope', async () => {
    await rig.setup('omp port w9', {
      settings: { tools: { core: ['read_file'] } },
      fakeResponsesPath: RESPONSES,
    });

    const dir = rig.testDir!;
    mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true });
    writeFileSync(
      join(dir, '.cursor', 'rules', 'house.mdc'),
      `---\ndescription: house style\nalwaysApply: true\n---\nAlways use pnpm in this repository.\n`,
    );
    writeFileSync(
      join(dir, '.cursor', 'rules', 'scoped.mdc'),
      `---\ndescription: scoped\nglobs: "**/*.ts"\n---\nNever use \`any\` in TypeScript files.\n`,
    );
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(
      join(dir, '.github', 'copilot-instructions.md'),
      `Prefer named exports over default exports.\n`,
    );

    await rig.run({
      args: 'what conventions apply here?',
      env: systemPromptEnv(),
    });

    const system = readFileSync(systemPromptPath(), 'utf8');
    const last = system;

    // Unconditional rules are inlined as instructions.
    expect(last).toContain('<imported-rules>');
    expect(last).toContain('Always use pnpm in this repository.');
    expect(last).toContain('Prefer named exports over default exports.');

    // A glob-scoped rule is listed, not inlined: applying it everywhere would
    // be wrong in every file outside its glob.
    expect(last).toContain('<rulebook>');
    expect(last).toContain('scoped.mdc');
    expect(last).not.toContain('Never use `any` in TypeScript files.');
  });

  it('leaves the prompt alone when the repo has no foreign config', async () => {
    await rig.setup('omp port w9 clean', {
      settings: { tools: { core: ['read_file'] } },
      fakeResponsesPath: RESPONSES,
    });

    await rig.run({
      args: 'nothing unusual here',
      env: systemPromptEnv(),
    });

    const last = readFileSync(systemPromptPath(), 'utf8');
    expect(last).not.toContain('<imported-rules>');
  });
});
