/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { TextInput } from '../components/shared/TextInput.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface VllmAuthDialogProps {
  onSubmit: (baseUrl: string, apiKey: string) => void;
  onCancel: () => void;
  error?: string | null;
  defaultBaseUrl?: string;
  defaultApiKey?: string;
}

export function VllmAuthDialog({
  onSubmit,
  onCancel,
  error,
  defaultBaseUrl = '',
  defaultApiKey = '',
}: VllmAuthDialogProps): React.JSX.Element {
  const { terminalWidth } = useUIState();
  const viewportWidth = terminalWidth - 8;
  const [activeField, setActiveField] = useState<'url' | 'key'>('url');

  const urlBuffer = useTextBuffer({
    initialText: defaultBaseUrl,
    initialCursorOffset: defaultBaseUrl.length,
    viewport: { width: viewportWidth, height: 4 },
    singleLine: true,
  });

  const keyBuffer = useTextBuffer({
    initialText: defaultApiKey,
    initialCursorOffset: defaultApiKey.length,
    viewport: { width: viewportWidth, height: 4 },
    inputFilter: (text) => text.replace(/[\r\n]/g, ''),
    singleLine: true,
  });

  useKeypress(
    (key) => {
      if (key.name === 'tab') {
        setActiveField((f) => (f === 'url' ? 'key' : 'url'));
        return true;
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (activeField === 'url') {
          setActiveField('key');
          return true;
        }
        onSubmit(urlBuffer.text, keyBuffer.text);
        return true;
      }
      return false;
    },
    { isActive: true },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.ui.focus}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold color={theme.text.primary}>
        Configure vLLM Connection
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.primary}>
          Connect to a vLLM server hosting Gemma or other compatible models.
        </Text>
        <Text color={theme.text.secondary}>
          vLLM must be started with --enable-gemini-api flag (v0.8.0+)
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.primary}>Base URL:</Text>
        <Box
          borderStyle="round"
          borderColor={
            activeField === 'url' ? theme.ui.focus : theme.border.default
          }
          paddingX={1}
        >
          <TextInput
            buffer={urlBuffer}
            onSubmit={() => setActiveField('key')}
            onCancel={onCancel}
            placeholder="http://localhost:8000"
            focus={activeField === 'url'}
          />
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.primary}>API Key (optional):</Text>
        <Box
          borderStyle="round"
          borderColor={
            activeField === 'key' ? theme.ui.focus : theme.border.default
          }
          paddingX={1}
        >
          <TextInput
            buffer={keyBuffer}
            onSubmit={() => onSubmit(urlBuffer.text, keyBuffer.text)}
            onCancel={onCancel}
            placeholder="Leave empty if not required"
            focus={activeField === 'key'}
          />
        </Box>
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          (Tab to switch fields, Enter to confirm, Esc to cancel)
        </Text>
      </Box>
    </Box>
  );
}
