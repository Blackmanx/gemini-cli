/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Discovery of MCP server definitions from foreign agents' config files.
 *
 * This module only reads. It never connects to a server, never spawns a
 * process, and never writes to settings: connecting to a server the user did
 * not configure is a trust decision, and the integrator makes it explicitly
 * after showing what was found.
 */

import * as path from 'node:path';
import { debugLogger } from '../utils/debugLogger.js';
import { homedir } from '../utils/paths.js';
import { isRecord } from '../utils/markdownUtils.js';
import { readTextFileIfPresent } from './rules.js';

/** A server definition lifted verbatim out of a foreign config file. */
export interface DiscoveredMcpServer {
  /** Server name as written in the config's `mcpServers` map. */
  name: string;
  /** The server's definition, unmodified and unexpanded. */
  config: Record<string, unknown>;
  /**
   * Where the definition came from, e.g. `project:.cursor/mcp.json` or
   * `user:~/.cursor/mcp.json`. Stable enough to dedup on, and it records the
   * project/user split the integrator needs before enabling anything.
   */
  source: string;
}

/** One config file to look at, with the source id its servers will carry. */
interface McpConfigLocation {
  source: string;
  filePath: string;
}

/** The foreign config files consulted: project files first, then the user one. */
function mcpConfigLocations(targetDir: string): McpConfigLocation[] {
  const root = path.resolve(targetDir);
  const home = homedir();
  return [
    { source: 'project:.mcp.json', filePath: path.join(root, '.mcp.json') },
    {
      source: 'project:.cursor/mcp.json',
      filePath: path.join(root, '.cursor', 'mcp.json'),
    },
    {
      source: 'project:.claude/mcp.json',
      filePath: path.join(root, '.claude', 'mcp.json'),
    },
    ...(home
      ? [
          {
            source: 'user:~/.cursor/mcp.json',
            filePath: path.join(home, '.cursor', 'mcp.json'),
          },
        ]
      : []),
  ];
}

function warn(message: string): void {
  debugLogger.warn(`[discovery] ${message}`);
}

/** Read one config file, skipping it entirely when it holds no usable servers. */
async function readMcpConfig(
  location: McpConfigLocation,
): Promise<DiscoveredMcpServer[]> {
  const raw = await readTextFileIfPresent(location.filePath);
  if (raw === undefined) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warn(`Skipping ${location.filePath}: invalid JSON (${reason})`);
    return [];
  }

  if (!isRecord(parsed)) {
    warn(`Skipping ${location.filePath}: top level is not an object`);
    return [];
  }

  const declared = parsed['mcpServers'];
  if (declared === undefined) {
    return [];
  }
  if (!isRecord(declared)) {
    warn(`Skipping ${location.filePath}: 'mcpServers' is not an object`);
    return [];
  }

  const servers: DiscoveredMcpServer[] = [];
  for (const [name, config] of Object.entries(declared)) {
    if (!isRecord(config)) {
      warn(`Skipping server "${name}" in ${location.filePath}: not an object`);
      continue;
    }
    servers.push({ name, config, source: location.source });
  }
  return servers;
}

/**
 * Collect MCP server definitions declared by other agents in `targetDir` or in
 * the user's home directory. Duplicate names across files are returned as-is:
 * deciding which definition wins is the integrator's call, not discovery's.
 */
export async function loadForeignMcpServers(
  targetDir: string,
): Promise<DiscoveredMcpServer[]> {
  const servers: DiscoveredMcpServer[] = [];
  for (const location of mcpConfigLocations(targetDir)) {
    servers.push(...(await readMcpConfig(location)));
  }
  return servers;
}
