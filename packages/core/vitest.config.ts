/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';
import * as os from 'node:os';

/**
 * How many test processes to run at once.
 *
 * Each one loads the package and its dependencies, so the number of cores
 * is a bad guide on a small virtual machine: plenty of cores, not enough
 * memory. The number is derived from the memory instead, and can be
 * overridden with `VITEST_MAX_FORKS`.
 */
function forksThatFit(): number {
  const override = Number(process.env['VITEST_MAX_FORKS']);
  if (Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const gigabytes = os.totalmem() / 1024 ** 3;
  // About 1 GB per process, and never more than four.
  return Math.max(1, Math.min(4, Math.floor(gigabytes / 1)));
}

export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    // A test that takes a minute is a test that is stuck.
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    silent: true,
    setupFiles: ['./test-setup.ts'],
    // The expected strings in these tests are written in English, and the
    // numbers in them are formatted the English way. The locale of the
    // machine running them decides otherwise, so it is pinned here: the
    // tests then check the same thing everywhere, while the CLI itself
    // keeps the format of the user's own locale.
    env: {
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    },
    outputFile: {
      junit: 'junit.xml',
    },
    coverage: {
      // Measuring coverage instruments every file and keeps the result in
      // memory for the whole run. It is worth that on CI, where the report
      // is collected, but not on a laptop, where it only makes the suite
      // slower and heavier. Pass `--coverage.enabled` to ask for it.
      enabled: process.env['CI'] === 'true',
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*'],
      reporter: [
        ['text', { file: 'full-text-summary.txt' }],
        'html',
        'json',
        'lcov',
        'cobertura',
        ['json-summary', { outputFile: 'coverage-summary.json' }],
      ],
    },
    poolOptions: {
      // These have to match the pool above. The options for threads were
      // being ignored while the forks pool was in use, so every run used
      // one process per core, which is more than the machine can hold.
      forks: {
        minForks: 1,
        maxForks: forksThatFit(),
      },
    },
  },
});
