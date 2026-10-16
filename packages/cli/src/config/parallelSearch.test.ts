/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { MCPServerConfig } from '@google/gemini-cli-core';
import {
  PARALLEL_SEARCH_SERVER_NAME,
  PARALLEL_SEARCH_URL,
  withParallelSearchServer,
} from './parallelSearch.js';

describe('withParallelSearchServer', () => {
  it('injects the free, trusted Streamable HTTP server by default', () => {
    const merged = withParallelSearchServer(undefined, undefined);
    const entry = merged[PARALLEL_SEARCH_SERVER_NAME];
    expect(entry.url).toBe(PARALLEL_SEARCH_URL);
    expect(entry.type).toBe('http');
    expect(entry.trust).toBe(true);
  });

  it('preserves every other configured server and never mutates the input', () => {
    const existing: Record<string, MCPServerConfig> = {
      local: { command: 'node', args: ['server.js'] },
    };
    const merged = withParallelSearchServer(existing, undefined);
    expect(Object.keys(merged).sort()).toEqual([
      'local',
      PARALLEL_SEARCH_SERVER_NAME,
    ]);
    expect(merged['local']).toBe(existing['local']);
    // The caller's map stays exactly as it was.
    expect(Object.keys(existing)).toEqual(['local']);
  });

  it('leaves the map untouched when omp.parallelSearch.enabled is false', () => {
    const existing: Record<string, MCPServerConfig> = {
      local: { command: 'node', args: ['server.js'] },
    };
    expect(withParallelSearchServer(existing, false)).toEqual(existing);
  });

  it('never overrides a user-configured parallel-search server', () => {
    const mine: MCPServerConfig = {
      url: 'https://example.invalid/mcp',
      type: 'http',
    };
    const merged = withParallelSearchServer(
      { [PARALLEL_SEARCH_SERVER_NAME]: mine },
      undefined,
    );
    expect(merged[PARALLEL_SEARCH_SERVER_NAME]).toBe(mine);
  });
});
