/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  AUTO_EXPAND_LIMIT,
  MAX_ATTACHMENT_SIZE,
  formatSize,
  shouldAutoExpand,
} from './display.js';

describe('display', () => {
  it('folds text that is too long to read at a glance', () => {
    expect(shouldAutoExpand('hola')).toBe(true);
    expect(shouldAutoExpand('x'.repeat(AUTO_EXPAND_LIMIT))).toBe(true);
    expect(shouldAutoExpand('x'.repeat(AUTO_EXPAND_LIMIT + 1))).toBe(false);
  });

  it('does not fold text that has not arrived yet', () => {
    expect(shouldAutoExpand(undefined)).toBe(false);
  });

  it('shows a size a person can read', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('allows files of a size worth sending', () => {
    expect(MAX_ATTACHMENT_SIZE).toBeGreaterThan(1024 * 1024);
  });
});
