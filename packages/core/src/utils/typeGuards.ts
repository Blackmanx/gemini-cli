/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isRecord } from './markdownUtils.js';

/**
 * Narrow `value` to a record carrying `prop`.
 *
 * The keyed form of the check, rather than `typeof value['prop']`, which the
 * lint config bans precisely because a bare `typeof` on a property hides the
 * data contract from readers.
 */
export function hasProperty<T extends string>(
  value: unknown,
  prop: T,
): value is Record<T, unknown> {
  return isRecord(value) && prop in value;
}

/** Narrow `value` to a record where `prop` holds a string. */
export function isStringProperty<T extends string>(
  value: unknown,
  prop: T,
): value is Record<T, string> {
  return hasProperty(value, prop) && typeof value[prop] === 'string';
}
