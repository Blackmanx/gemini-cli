/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Registry of rule discovery providers.
 *
 * Providers run in descending priority and the first one to claim a rule NAME
 * keeps it — name is the identity a user reasons about ("my `testing` rule"),
 * so a higher-priority provider silently replaces a lower-priority one rather
 * than both being injected into the prompt.
 *
 * Discovery never throws. A provider that fails or a lower-priority rule that
 * lost its name comes back as a note, so one broken importer cannot cost the
 * user every other importer's rules. (An unparsable rule file is logged by the
 * importer itself, whose `load` signature carries no note channel.)
 */

import { unparsedFiles ,
  loadClaudeRules,
  loadClineRules,
  loadCursorRules,
  loadGitHubRules,
} from './rules.js';
import { debugLogger } from '../utils/debugLogger.js';
import type {
  DiscoveredRule,
  DiscoveryProvider,
  DiscoveryResult,
} from './types.js';

const providers: DiscoveryProvider[] = [];

/**
 * Register a discovery provider, keeping the list sorted by descending
 * priority. Re-registering an existing id replaces it in place.
 */
export function registerProvider(provider: DiscoveryProvider): void {
  const existing = providers.findIndex((entry) => entry.id === provider.id);
  if (existing !== -1) {
    providers.splice(existing, 1);
  }
  const insertAt = providers.findIndex(
    (entry) => entry.priority < provider.priority,
  );
  if (insertAt === -1) {
    providers.push(provider);
  } else {
    providers.splice(insertAt, 0, provider);
  }
}

/** The registered providers, highest priority first. */
export function getProviders(): DiscoveryProvider[] {
  return [...providers];
}

/**
 * Run every registered provider over `targetDir` and return the deduplicated
 * rules plus notes describing anything that was skipped or shadowed.
 */
export async function discoverRules(
  targetDir: string,
): Promise<DiscoveryResult> {
  const settled = await Promise.allSettled(
    providers.map((provider) => provider.load(targetDir)),
  );

  const notes: string[] = [];
  const rules: DiscoveredRule[] = [];
  const claimedNames = new Set<string>();
  // A rule file the importer could not parse is a note, not a silence: the
  // user wrote it and will otherwise never learn it is being ignored.
  for (const file of unparsedFiles) {
    notes.push(`skipped ${file}: its frontmatter block is unusable`);
  }
  unparsedFiles.length = 0;

  for (const [index, provider] of providers.entries()) {
    const outcome = settled[index];
    if (outcome === undefined) {
      continue;
    }
    if (outcome.status === 'rejected') {
      const reason =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      const message = `[${provider.displayName}] failed to load: ${reason}`;
      notes.push(message);
      debugLogger.warn(`[discovery] ${message}`);
      continue;
    }

    if (!Array.isArray(outcome.value)) {
      const message = `[${provider.displayName}] returned a non-array result`;
      notes.push(message);
      debugLogger.warn(`[discovery] ${message}`);
      continue;
    }

    for (const rule of outcome.value) {
      if (claimedNames.has(rule.name)) {
        const message = `[${provider.displayName}] rule "${rule.name}" is shadowed by a higher-priority provider`;
        notes.push(message);
        debugLogger.warn(`[discovery] ${message}`);
        continue;
      }
      claimedNames.add(rule.name);
      rules.push(rule);
    }
  }

  return { rules, notes };
}

registerProvider({
  id: 'claude',
  displayName: 'Claude Code',
  priority: 80,
  load: loadClaudeRules,
});

registerProvider({
  id: 'cursor',
  displayName: 'Cursor',
  priority: 50,
  load: loadCursorRules,
});

registerProvider({
  id: 'cline',
  displayName: 'Cline',
  priority: 40,
  load: loadClineRules,
});

registerProvider({
  id: 'github',
  displayName: 'GitHub Copilot',
  priority: 30,
  load: loadGitHubRules,
});
