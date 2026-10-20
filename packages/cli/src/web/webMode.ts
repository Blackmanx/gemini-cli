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

  // The signal handlers go in before the browser is opened, and the
  // browser is opened without waiting for it: launching a browser can take
  // as long as the browser stays open, and until this point Ctrl+C did
  // nothing because the handler had not been installed yet.
  const done = new Promise<void>((resolve) => {
    const shutdown = () => {
      // A second Ctrl+C always works, whatever is still shutting down.
      process.once('SIGINT', () => process.exit(0));
      process.once('SIGTERM', () => process.exit(0));
      // Stopping can wait on the agent, so it is given a few seconds and
      // then the process goes anyway: the user asked it to stop.
      void Promise.race([
        server.stop(),
        new Promise<void>((stopWaiting) => setTimeout(stopWaiting, 3000)),
      ]).finally(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  if (argv.webOpen !== false) {
    void openBrowserSecurely(url).catch((error: unknown) => {
      debugLogger.warn('web: could not open a browser:', error);
      process.stdout.write(`  Open ${url} in your browser.\n`);
    });
  }

  await done;

  // Nothing should be left, but the agent may still hold a timer; the
  // process was asked to stop, so it does.
  process.exit(0);
}
