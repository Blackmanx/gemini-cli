/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPoliciesFromToml } from './toml-loader.js';
import { PolicyEngine } from './policy-engine.js';
import { ApprovalMode, PolicyDecision } from './types.js';
import { UPDATE_TOPIC_TOOL_NAME } from '../tools/tool-names.js';

describe('Topic Tool Policy', () => {
  async function loadDefaultPolicies() {
    // Resolved from this module, not from process.cwd(): the test runner's
    // cwd is the repo root, so a cwd-relative path silently resolved to
    // nothing and the engine fell back to its default of asking for every
    // tool - which is how this test came to expect `allow` and get `ask_user`.
    const policiesDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'policies',
    );
    const getPolicyTier = () => 1; // Default tier
    const result = await loadPoliciesFromToml([policiesDir], getPolicyTier);
    return result.rules;
  }

  it('should allow update_topic in DEFAULT mode', async () => {
    const rules = await loadDefaultPolicies();
    const engine = new PolicyEngine({
      rules,
      approvalMode: ApprovalMode.DEFAULT,
    });

    const result = await engine.check(
      { name: UPDATE_TOPIC_TOOL_NAME },
      undefined,
    );
    expect(result.decision).toBe(PolicyDecision.ALLOW);
  });

  it('should allow update_topic in PLAN mode', async () => {
    const rules = await loadDefaultPolicies();
    const engine = new PolicyEngine({
      rules,
      approvalMode: ApprovalMode.PLAN,
    });

    const result = await engine.check(
      { name: UPDATE_TOPIC_TOOL_NAME },
      undefined,
    );
    expect(result.decision).toBe(PolicyDecision.ALLOW);
  });

  it('should allow update_topic in YOLO mode', async () => {
    const rules = await loadDefaultPolicies();
    const engine = new PolicyEngine({
      rules,
      approvalMode: ApprovalMode.YOLO,
    });

    const result = await engine.check(
      { name: UPDATE_TOPIC_TOOL_NAME },
      undefined,
    );
    expect(result.decision).toBe(PolicyDecision.ALLOW);
  });
});
