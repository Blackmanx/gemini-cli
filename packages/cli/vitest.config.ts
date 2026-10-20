/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * How many test processes to run at once.
 *
 * Each one loads the whole CLI with its terminal UI, which is a few
 * hundred megabytes before a single test runs. The number of cores is a
 * bad guide here: a small virtual machine has plenty of cores and not
 * enough memory, and asking for more processes than the memory can hold
 * is what makes it swap and fall over. The number is derived from the
 * memory instead, and can be overridden with `VITEST_MAX_FORKS`.
 */
function forksThatFit(): number {
  const override = Number(process.env['VITEST_MAX_FORKS']);
  if (Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const gigabytes = os.totalmem() / 1024 ** 3;
  // About 2.5 GB per process, and never more than four: past that the
  // gain in speed is small and the risk of running out of memory is not.
  return Math.max(1, Math.min(4, Math.floor(gigabytes / 2.5)));
}

export default defineConfig({
  resolve: {
    conditions: ['test'],
  },
  test: {
    include: ['**/*.{test,spec}.{js,ts,jsx,tsx}', 'config.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/cypress/**'],
    environment: 'node',
    globals: true,
    reporters: ['default', 'junit'],

    outputFile: {
      junit: 'junit.xml',
    },
    alias: {
      react: path.resolve(__dirname, '../../node_modules/react'),
    },
    setupFiles: ['./test-setup.ts'],
    // The snapshots were written in English, and the numbers in them are
    // formatted the English way. The locale of the machine running the
    // tests decides otherwise, so it is pinned here: the tests then check
    // the same thing everywhere, while the CLI itself keeps the format of
    // the user's own locale.
    env: {
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    },
    // A test that takes a minute is a test that is stuck. Nothing in this
    // suite takes more than a few seconds, so the limit is low enough to
    // catch a hang and high enough not to catch a slow machine.
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
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
    server: {
      deps: {
        inline: [/@google\/gemini-cli-core/],
      },
    },
  },
});
