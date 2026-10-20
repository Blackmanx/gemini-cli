/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@google/gemini-cli-core';
import {
  AuthType,
  debugLogger,
  openBrowserSecurely,
} from '@google/gemini-cli-core';
import type { LoadedSettings } from '../config/settings.js';
import type { CliArgs } from '../config/config.js';
import { WebServer } from './webServer.js';

/**
 * Runs the agent behind a local web UI until the user stops it.
 *
 * The server binds to the loopback interface only: it exposes the user's
 * agent, its credentials and its filesystem access, so it must not be
 * reachable from the network.
 */
export async function runWebServer(
  config: Config,
  settings: LoadedSettings,
  argv: CliArgs,
): Promise<void> {
  // The agent needs a content generator before it can talk to the model.
  const authType =
    settings.merged.security.auth.selectedType ??
    (process.env['GOOGLE_GEMINI_BASE_URL']
      ? AuthType.GATEWAY
      : AuthType.USE_GEMINI);
  await config.refreshAuth(authType);

  const server = new WebServer({
    config,
    settings,
    cwd: config.getTargetDir() ?? process.cwd(),
    port: argv.webPort,
    host: argv.webHost,
  });

  const url = await server.start();

  process.stdout.write(
    `\n  Gemini CLI is running at ${url}\n` +
      `  Workspace: ${config.getTargetDir() ?? process.cwd()}\n` +
      `  Press Ctrl+C to stop.\n\n`,
  );

  if (argv.webOpen !== false) {
    try {
      await openBrowserSecurely(url);
    } catch (error) {
      debugLogger.warn('web: could not open a browser:', error);
      process.stdout.write(`  Open ${url} in your browser.\n`);
    }
  }

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void server.stop().finally(() => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
