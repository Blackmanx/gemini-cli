/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

const RESPONSES = join(import.meta.dirname, 'omp-port-w9.responses');

describe('omp port: appending to the system prompt', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('adds APPEND_SYSTEM.md without losing the generated prompt', async () => {
    await rig.setup('omp port w9b', {
      settings: { tools: { core: ['read_file'] } },
      fakeResponsesPath: RESPONSES,
    });

    // The file wins over the setting, matching how every other
    // project-scoped file behaves here.
    writeFileSync(
      join(rig.testDir!, 'APPEND_SYSTEM.md'),
      'RULE_FROM_THE_FILE\n',
    );

    await rig.run({
      args: 'what are the house rules?',
      env: {
        GEMINI_WRITE_SYSTEM_MD: join(rig.homeDir!, 'system.md'),
      },
    });

    const system = readFileSync(join(rig.homeDir!, 'system.md'), 'utf8');

    expect(system).toContain('# User instructions');
    expect(system).toContain('RULE_FROM_THE_FILE');

    // The generated prompt is still whole: appending must not truncate it.
    expect(system).toContain('You are Gemini CLI, an autonomous CLI agent');
    expect(system.length).toBeGreaterThan(2000);
  });
});
