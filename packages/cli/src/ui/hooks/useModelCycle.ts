/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo } from 'react';
import type { Config } from '@google/gemini-cli-core';

/**
 * Cycle through the configured model roles.
 *
 * Ported from omp's `Ctrl+P` model switching. The idea is that the right
 * model for a step is usually obvious — a slow one to design, a cheap one to
 * grind through a rename — and the cost of stopping to open a dialog to
 * change it is what stops people doing it.
 *
 * The cycle order comes from `model.cycleOrder` and each entry resolves
 * through `model.roles`, so a role can name any Gemini model or model-config
 * alias. It never reaches outside Gemini: a role that does not resolve is
 * skipped rather than resolved to something surprising.
 */
export interface ModelCycleEntry {
  role: string;
  /** The model or alias the role points at, or `undefined` when unset. */
  model: string | undefined;
}

export interface UseModelCycleReturn {
  /** The roles the cycle will visit, in order. */
  entries: ModelCycleEntry[];
  /** The next model to move to, or `undefined` when the cycle is inert. */
  nextModel: string | undefined;
  /** Advance to the next role and return its model, or `undefined`. */
  cycle: () => string | undefined;
}

export function useModelCycle(
  config: Config,
  currentModel: string,
  onModelChange: (model: string) => void,
): UseModelCycleReturn {
  const entries = useMemo<ModelCycleEntry[]>(() => {
    const order = config.getModelCycleOrder();
    const roles = config.getModelRoles();
    if (!Array.isArray(order) || order.length === 0) return [];
    return order
      .filter((role): role is string => typeof role === 'string')
      .map((role) => ({ role, model: roles[role] }));
  }, [config]);

  const nextModel = useMemo(() => {
    // An entry with no model is a role the user named but never assigned.
    // Skipping it keeps the cycle from "arriving" at a role that does nothing.
    const configured = entries.filter((e) => e.model !== undefined);
    if (configured.length === 0) return undefined;
    const index = configured.findIndex((e) => e.model === currentModel);
    if (index === -1) return configured[0].model;
    return configured[(index + 1) % configured.length].model;
  }, [entries, currentModel]);

  const cycle = useCallback((): string | undefined => {
    if (nextModel === undefined) return undefined;
    onModelChange(nextModel);
    return nextModel;
  }, [nextModel, onModelChange]);

  return { entries, nextModel, cycle };
}
