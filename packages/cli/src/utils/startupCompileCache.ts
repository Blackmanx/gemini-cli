/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import module from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the V8 code cache lives.
 *
 * Node's default is a directory under the OS temp dir, which is fine for a
 * server and wrong for a CLI: temp is swept, often per-boot, so the cache would
 * be cold exactly as often as it matters. Keying it off the same directory the
 * CLI already keeps state in keeps it alive across reboots.
 */
export function compileCacheDir(): string {
  const baseDir =
    process.env['GEMINI_CLI_HOME'] || join(os.homedir(), '.gemini');
  return join(baseDir, 'compile-cache');
}

/**
 * Turn on V8's on-disk code cache for this process.
 *
 * Profiling a cold start showed ~20% of startup inside
 * `compileSourceTextModule`: one bundle chunk alone accounts for ~170MB of
 * resident heap and most of a second, and every invocation pays to compile it
 * again.
 *
 * Best-effort by design. A read-only or missing home directory must not stop the
 * CLI from starting, so every failure here is swallowed.
 */
export function enableStartupCompileCache(): void {
  // Escape hatch: a stale or unwritable cache is a startup-latency problem with
  // no visible symptom, so there has to be a way to turn it off without
  // reinstalling.
  if (process.env['GEMINI_CLI_NO_COMPILE_CACHE']) {
    return;
  }
  try {
    // Synchronous on purpose: the directory has to exist before the heavy import
    // begins, and an await here would hand the event loop a chance to load
    // exactly the code we wanted cached.
    mkdirSync(compileCacheDir(), { recursive: true });
    if (
      'enableCompileCache' in module &&
      typeof module.enableCompileCache === 'function'
    ) {
      module.enableCompileCache(compileCacheDir());
    }
  } catch {
    // No cache is strictly better than no CLI.
  }
}
