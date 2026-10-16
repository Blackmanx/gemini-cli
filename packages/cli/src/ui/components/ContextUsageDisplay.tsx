/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { getContextUsage } from '../utils/contextUsage.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { DEFAULT_COMPRESSION_THRESHOLD } from '../constants.js';

export type ContextUsageTier = 'full' | 'bar' | 'pct';

/**
 * How much context usage can show at a given terminal width:
 *  - full: `[█████░░░░░] 50% · 500k/1.0M`
 *  - bar:  `[█████░░░░░] 50%`
 *  - pct:  `50%`
 */
export function contextUsageTier(terminalWidth: number): ContextUsageTier {
  if (terminalWidth >= 110) return 'full';
  if (terminalWidth >= 90) return 'bar';
  return 'pct';
}

/**
 * Worst-case rendered width per tier, so the footer layout can budget the
 * column before the component renders.
 */
export function contextUsageReservedWidth(terminalWidth: number): number {
  switch (contextUsageTier(terminalWidth)) {
    case 'full':
      return 30; // "[██████████] 100% · 1.0M/1.0M"
    case 'bar':
      return 17; // "[██████████] 100%"
    case 'pct':
    default:
      return 4; // "100%"
  }
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const ContextUsageDisplay = ({
  promptTokenCount,
  model,
  terminalWidth,
}: {
  promptTokenCount: number;
  model: string | undefined;
  terminalWidth: number;
}) => {
  const settings = useSettings();
  const { used, limit, fraction } = getContextUsage(promptTokenCount, model);
  const percentageUsed = (fraction * 100).toFixed(0);

  const threshold =
    settings.merged.model?.compressionThreshold ??
    DEFAULT_COMPRESSION_THRESHOLD;

  let textColor = theme.text.secondary;
  if (fraction >= 1.0) {
    textColor = theme.status.error;
  } else if (fraction >= threshold) {
    textColor = theme.status.warning;
  }

  // Without a known context window only the bare percentage is meaningful.
  const tier = limit > 0 ? contextUsageTier(terminalWidth) : 'pct';

  if (tier === 'pct') {
    return <Text color={textColor}>{percentageUsed}%</Text>;
  }

  const filled = Math.max(0, Math.min(10, Math.round(fraction * 10)));
  const gauge = (
    <>
      {'['}
      {'█'.repeat(filled)}
      <Text color={theme.ui.dark}>{'░'.repeat(10 - filled)}</Text>
      {']'}
    </>
  );

  if (tier === 'bar') {
    return (
      <Text color={textColor}>
        {gauge} {percentageUsed}%
      </Text>
    );
  }

  return (
    <Text color={textColor}>
      {gauge} {percentageUsed}% · {formatTokenCount(used)}/
      {formatTokenCount(limit)}
    </Text>
  );
};
