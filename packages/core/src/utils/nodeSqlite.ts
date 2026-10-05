/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

/** The slice of the `node:sqlite` namespace this module hands back. */
export type NodeSqliteModule = { DatabaseSync: typeof DatabaseSync };

/**
 * The single point where `node:sqlite` is loaded.
 *
 * `node:sqlite` is still flagged experimental, and Node prints an
 * `ExperimentalWarning` the moment the module is loaded. A static
 * `import ... from 'node:sqlite'` in any eagerly-loaded module therefore makes
 * every session print the warning, including the sessions that never touch a
 * database. The builtin has no per-feature opt-out — `--disable-warning=SQLite`
 * is not a thing, only `--disable-warning=ExperimentalWarning`, which would
 * also silence unrelated experimental features — so the only lever is *when*
 * the module gets loaded.
 *
 * Hence `require` on first use instead of a static import: the load stays
 * synchronous, so the synchronous call sites that need it are unaffected, and
 * it stays fully typed because `import type` is erased at compile time and
 * carries no runtime cost.
 */
export type { DatabaseSync };

let cached: typeof DatabaseSync | undefined;

/**
 * Loads `node:sqlite` on first call and returns its `DatabaseSync` class.
 *
 * Every caller goes through here, so the experimental warning is printed at
 * most once per process, and only by processes that actually read a database.
 */
export function loadDatabaseSync(): typeof DatabaseSync {
  let DatabaseSyncClass = cached;
  if (DatabaseSyncClass === undefined) {
    const loaded: unknown = createRequire(import.meta.url)('node:sqlite');
    if (!isNodeSqliteModule(loaded)) {
      throw new Error(
        'node:sqlite loaded without exposing a DatabaseSync class.',
      );
    }
    DatabaseSyncClass = loaded.DatabaseSync;
    cached = DatabaseSyncClass;
  }
  return DatabaseSyncClass;
}

function isNodeSqliteModule(value: unknown): value is NodeSqliteModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'DatabaseSync' in value &&
    typeof value.DatabaseSync === 'function'
  );
}
