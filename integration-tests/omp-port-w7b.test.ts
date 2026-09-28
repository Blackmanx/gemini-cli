/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

const RESPONSES = join(import.meta.dirname, 'omp-port-w7b.responses');

describe('omp port: learning a lesson', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('stores the lesson first, then mints the skill', async () => {
    await rig.setup('omp port w7b', {
      settings: {
        tools: { core: ['learn', 'retain', 'write_file'] },
        useMemory: true,
      },
      fakeResponsesPath: RESPONSES,
    });

    await rig.run({ args: 'remember how migrations work here' });

    const logs = rig.readToolLogs();
    const learn = logs.filter((l) => l.toolRequest.name === 'learn');
    expect(learn.length, 'learn ran once').toBe(1);
    expect(learn[0]!.toolRequest.success, learn[0]!.toolRequest.error).toBe(
      true,
    );

    // The skill landed on disk, under the managed root.
    const managedRoot = join(rig.homeDir!, '.gemini', 'managed-skills');
    expect(existsSync(managedRoot), 'managed skills root exists').toBe(true);
    const names = readdirSync(managedRoot);
    expect(names, 'the skill was created').toContain('add-migration');

    // The body is real content, not a stub.
    const skill = readFileSync(
      join(managedRoot, 'add-migration', 'SKILL.md'),
      'utf8',
    );
    expect(skill).toContain('Adding a migration');
    expect(skill).toContain('db/migrate/');

    // And the lesson is recallable, which is the half that must never be lost.
    const history = rig
      .readAllApiRequest()
      .map((entry) => entry.attributes?.request_text ?? '')
      .join('\n');
    expect(history).toContain('lexical order');
  });
});
