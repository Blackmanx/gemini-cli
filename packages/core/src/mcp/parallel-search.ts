/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared identity of the Parallel Search MCP default.
 *
 * The CLI injects a trusted `parallel-search` server
 * (https://search.parallel.ai/mcp) into the session's MCP surface; core needs
 * the name to recognize its tools (e.g. to steer built-in web search to
 * complement Parallel instead of competing with it).
 */
export const PARALLEL_SEARCH_SERVER_NAME = 'parallel-search';
