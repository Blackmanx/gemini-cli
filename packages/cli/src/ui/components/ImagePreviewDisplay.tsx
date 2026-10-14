/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { formatImageSize } from '../utils/imagePreview.js';
import type { ImagePreviewEntry } from '../hooks/useImagePreviews.js';

/**
 * Inline previews for the images referenced in the composer (`@path`
 * tokens): a half-block thumbnail when the format could be decoded, plus a
 * path/size label either way.
 */
export const ImagePreviewDisplay: React.FC<{
  entries: ImagePreviewEntry[];
}> = ({ entries }) => (
  <Box flexDirection="column" paddingLeft={2}>
    {entries.map((entry) => (
      <Box key={entry.absPath} flexDirection="row" alignItems="flex-start">
        {entry.preview.thumbnail ? (
          <Text>{entry.preview.thumbnail.join('\n')}</Text>
        ) : (
          <Text color={theme.text.secondary}>[image]</Text>
        )}
        <Box paddingLeft={1} flexDirection="column">
          <Text color={theme.text.secondary}>
            {entry.relPath}
            {entry.preview.width !== null && entry.preview.height !== null
              ? ` · ${entry.preview.width}×${entry.preview.height}`
              : ''}
            {' · '}
            {formatImageSize(entry.preview.byteSize)}
          </Text>
        </Box>
      </Box>
    ))}
  </Box>
);
