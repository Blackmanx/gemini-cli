/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    // A test that takes a minute is a test that is stuck.
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    silent: true,
    setupFiles: ['./test-setup.ts'],
    outputFile: {
      junit: 'junit.xml',
    },
    coverage: {
      enabled: true,
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
        maxForks: 8,
      },
    },
  },
});
