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
 * The number of cores is a bad guide on a small virtual machine: plenty
 * of cores, not enough memory. The number is derived from the memory
 * instead, and can be overridden with `VITEST_MAX_FORKS`.
 */
function forksThatFit(): number {
  const override = Number(process.env['VITEST_MAX_FORKS']);
  if (Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return Math.max(1, Math.min(4, Math.floor(os.totalmem() / 1024 ** 3)));
}

export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    silent: true,
    outputFile: {
      junit: 'junit.xml',
    },
    pool: 'forks',
    poolOptions: {
      // These have to match the pool above. The options for threads were
      // ignored while the forks pool was in use, so every run used one
      // process per core, which is more than the machine can hold.
      forks: {
        minForks: 1,
        maxForks: forksThatFit(),
      },
    },
  },
});
