/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    server: {
      deps: {
        inline: [/@google\/gemini-cli-core/],
      },
    },
  },
});
