/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type { InternalPage, SiteHandler } from './types.js';
export { findHandler, listHandlers, registerHandler } from './types.js';
export {
  htmlToMarkdown,
  isLowQualityOutput,
  isUnusableConversion,
} from './markdown.js';
// Importing the built-in table is what registers them; the registry is empty
// until this module is loaded.
import './handlers.js';
