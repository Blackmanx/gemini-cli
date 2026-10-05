/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadDatabaseSync } from './nodeSqlite.js';

const tempDirs: string[] = [];

function makeDatabase(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'node-sqlite-test-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'probe.db');
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t(name) VALUES ('hola'),('adios');",
  );
  db.close();
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadDatabaseSync', () => {
  it('resolves a usable DatabaseSync class', () => {
    expect(typeof loadDatabaseSync()).toBe('function');
  });

  it('returns the same class on repeated calls', () => {
    expect(loadDatabaseSync()).toBe(loadDatabaseSync());
  });

  it('opens a database, writes and reads rows back', () => {
    const file = makeDatabase();
    const DatabaseSync = loadDatabaseSync();
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT name FROM t ORDER BY id').all();
    db.close();

    expect(rows.map((row) => row['name'])).toEqual(['hola', 'adios']);
  });
});
