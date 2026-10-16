/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Parallel Search MCP default: a free, keyless web-search server wired
 * into the MCP surface out of the box.
 *
 * Parallel's hosted server (https://search.parallel.ai/mcp) exposes
 * `web_search` and `web_fetch` over Streamable HTTP with no account or API
 * key, under free-tier rate limits. The CLI injects it as a trusted server so
 * the model gets current web content without the token cost of grounded
 * search; `omp.parallelSearch.enabled` opts out, and a user-configured server
 * of the same name always wins, matching Parallel's own documented precedence
 * rule ("if you already configured parallel-search manually, that
 * configuration takes precedence").
 */
import type { MCPServerConfig } from '@google/gemini-cli-core';
import { PARALLEL_SEARCH_SERVER_NAME } from '@google/gemini-cli-core';

/** Server name under which the default is registered (tools: mcp_parallel-search_*). */
export { PARALLEL_SEARCH_SERVER_NAME };

/** Streamable HTTP endpoint of the free tier. No auth, no API key. */
export const PARALLEL_SEARCH_URL = 'https://search.parallel.ai/mcp';

/**
 * Return the MCP server map with the Parallel default added when it applies.
 *
 * - `enabled === false` (`omp.parallelSearch.enabled`) leaves the map alone.
 * - An existing `parallel-search` entry — manual or from an extension — is
 *   never overridden.
 * - The server is trusted: both tools are read-only search and fetch, and a
 *   confirmation prompt per query would make the free tier unusable.
 */
export function withParallelSearchServer(
  servers: Record<string, MCPServerConfig> | undefined,
  enabled: boolean | undefined,
): Record<string, MCPServerConfig> {
  const merged: Record<string, MCPServerConfig> = { ...servers };
  if (enabled === false) return merged;
  if (PARALLEL_SEARCH_SERVER_NAME in merged) return merged;
  merged[PARALLEL_SEARCH_SERVER_NAME] = {
    url: PARALLEL_SEARCH_URL,
    type: 'http',
    trust: true,
    description:
      'Parallel Search (free tier): current web search results with source links, and page fetches. No account or API key required; subject to free-tier rate limits.',
  };
  return merged;
}

/** Minimal settings shape needed to resolve the session's MCP server map. */
export interface McpServerHostSettings {
  mcpServers?: Record<string, MCPServerConfig>;
  admin?: {
    mcp?: { enabled?: boolean; config?: Record<string, MCPServerConfig> };
  };
  omp?: { parallelSearch?: { enabled?: boolean } };
}

/**
 * The MCP server map every session-facing surface should use (runtime config,
 * `gemini mcp list`, the policy engine): always a fresh object, with the
 * Parallel default applied unless admin policy already governs MCP — a kill
 * switch (`admin.mcp.enabled === false`) or an allowlist
 * (`admin.mcp.config`) leaves the map untouched. Central so no read path can
 * miss the default and leave the model without Parallel's tools.
 */
export function sessionMcpServers(
  settings: McpServerHostSettings,
): Record<string, MCPServerConfig> {
  if (settings.admin?.mcp?.enabled === false) {
    return { ...settings.mcpServers };
  }
  const allowlist = settings.admin?.mcp?.config;
  if (allowlist && Object.keys(allowlist).length > 0) {
    return { ...settings.mcpServers };
  }
  return withParallelSearchServer(
    settings.mcpServers,
    settings.omp?.parallelSearch?.enabled,
  );
}
