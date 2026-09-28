/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The payload a {@link SiteHandler} (or the generic page reader) produces for
 * the URL the user asked about.
 */
export interface InternalPage {
  /** Rendered body: markdown for human/model consumption, or raw JSON. */
  content: string;
  contentType: 'text/markdown' | 'application/json';
  /** Caveats the reader should surface: truncations, partial data, guesses. */
  notes?: string[];
}

/**
 * A site-specific reader. Handlers never throw for "unusual" input: they
 * return `null` so the caller can fall back to plain fetching.
 */
export interface SiteHandler {
  /** Host suffixes this handler claims, e.g. `['github.com']`. */
  hosts: readonly string[];
  /** What this handler produces, for the reader's log line. */
  kind: string;
  /** Return content to use instead of fetching the page, or null to fall through. */
  handle(url: URL, signal?: AbortSignal): Promise<InternalPage | null>;
}

const registry: SiteHandler[] = [];

/**
 * Registers a handler. The registry is process-global and registration
 * ordered; the most recent registration for a host wins, so an integrator can
 * override a built-in by registering their own afterwards.
 */
export function registerHandler(handler: SiteHandler): void {
  registry.push(handler);
}

/** Returns the most recently registered handler for this URL's host. */
export function findHandler(url: URL): SiteHandler | undefined {
  const hostname = url.hostname.toLowerCase();
  for (let i = registry.length - 1; i >= 0; i--) {
    const handler = registry[i];
    if (handler === undefined) {
      continue;
    }
    const matches = handler.hosts.some((suffix) => {
      const claim = suffix.toLowerCase().replace(/^\./, '');
      return hostname === claim || hostname.endsWith(`.${claim}`);
    });
    if (matches) {
      return handler;
    }
  }
  return undefined;
}

/** All registered handlers, in registration order. */
export function listHandlers(): SiteHandler[] {
  return [...registry];
}
