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
  sessionMcpServers,
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

describe('sessionMcpServers', () => {
  it('applies the Parallel default like withParallelSearchServer', () => {
    const servers = sessionMcpServers({});
    expect(servers[PARALLEL_SEARCH_SERVER_NAME]?.url).toBe(PARALLEL_SEARCH_URL);
  });

  it('returns a fresh object and never touches the input map', () => {
    const input: Record<string, MCPServerConfig> = {
      local: { command: 'node', args: ['server.js'] },
    };
    const resolved = sessionMcpServers({ mcpServers: input });
    expect(resolved).not.toBe(input);
    resolved[PARALLEL_SEARCH_SERVER_NAME] = { command: 'mutated' };
    expect(input).toEqual({ local: { command: 'node', args: ['server.js'] } });
  });

  it('skips injection when an admin MCP allowlist governs the servers', () => {
    const input: Record<string, MCPServerConfig> = {
      allowed: { command: 'ok' },
    };
    expect(
      sessionMcpServers({
        mcpServers: input,
        admin: { mcp: { config: { allowed: { command: 'ok' } } } },
      }),
    ).toEqual(input);
  });

  it('skips injection when the admin MCP kill switch is off', () => {
    expect(sessionMcpServers({ admin: { mcp: { enabled: false } } })).toEqual(
      {},
    );
  });

  it('honors omp.parallelSearch.enabled === false', () => {
    expect(
      sessionMcpServers({ omp: { parallelSearch: { enabled: false } } }),
    ).toEqual({});
  });
});
