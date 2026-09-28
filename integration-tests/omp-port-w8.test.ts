/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { TestRig } from './test-helper.js';

const RESPONSES = join(import.meta.dirname, 'omp-port-w8.responses');

describe('omp port: magic keywords', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('injects the ultrathink notice for that turn only', async () => {
    await rig.setup('omp port w8', {
      settings: { tools: { core: ['read_file'] } },
      fakeResponsesPath: RESPONSES,
    });

    await rig.run({ args: 'ultrathink about the failure modes' });

    const requests = rig
      .readAllApiRequest()
      .map((entry) => entry.attributes?.request_text ?? '');
    const last = requests[requests.length - 1] ?? '';

    // The notice rides with the user's message.
    expect(last).toContain('ultrathink about the failure modes');
    expect(last).toMatch(/<system-reminder>/);
    expect(last).toMatch(/carefully|deliberately/i);
  });

  it('leaves a prompt with no keyword untouched', async () => {
    await rig.setup('omp port w8 plain', {
      settings: { tools: { core: ['read_file'] } },
      fakeResponsesPath: RESPONSES,
    });

    await rig.run({ args: 'just do the thing' });

    const requests = rig
      .readAllApiRequest()
      .map((entry) => entry.attributes?.request_text ?? '');
    const last = requests[requests.length - 1] ?? '';
    expect(last).toContain('just do the thing');
    expect(last).not.toContain('<system-reminder>');
  });

  it('respects a disabled keyword', async () => {
    await rig.setup('omp port w8 off', {
      settings: {
        tools: { core: ['read_file'] },
        magicKeywords: { ultrathink: false },
      },
      fakeResponsesPath: RESPONSES,
    });

    await rig.run({ args: 'ultrathink about the failure modes' });

    const requests = rig
      .readAllApiRequest()
      .map((entry) => entry.attributes?.request_text ?? '');
    const last = requests[requests.length - 1] ?? '';
    expect(last).not.toContain('<system-reminder>');
  });
});
