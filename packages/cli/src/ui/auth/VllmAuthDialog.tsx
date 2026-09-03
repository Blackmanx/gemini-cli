/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { fetchVllmModels } from '@google/gemini-cli-core';
import { theme } from '../semantic-colors.js';
import { TextInput } from '../components/shared/TextInput.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface VllmAuthDialogProps {
  onSubmit: (baseUrl: string, apiKey: string, model?: string) => void;
  onCancel: () => void;
  error?: string | null;
  defaultBaseUrl?: string;
  defaultApiKey?: string;
  defaultModel?: string;
}

export function VllmAuthDialog({
  onSubmit,
  onCancel,
  error,
  defaultBaseUrl = '',
  defaultApiKey = '',
  defaultModel = '',
}: VllmAuthDialogProps): React.JSX.Element {
  const { terminalWidth } = useUIState();
  const viewportWidth = terminalWidth - 8;
  const [activeField, setActiveField] = useState<'url' | 'key' | 'model'>(
    'url',
  );
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);

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

  const modelBuffer = useTextBuffer({
    initialText: defaultModel,
    initialCursorOffset: defaultModel.length,
    viewport: { width: viewportWidth, height: 4 },
    inputFilter: (text) => text.replace(/[\r\n]/g, ''),
    singleLine: true,
  });

  // Attempt to discover models from the vLLM server when URL changes or on mount
  useEffect(() => {
    const trimmedUrl = urlBuffer.text.trim();
    if (!trimmedUrl) {
      setDiscoveredModels([]);
      return;
    }

    let isMounted = true;
    void fetchVllmModels(trimmedUrl, keyBuffer.text.trim()).then(
      (models: string[]) => {
        if (!isMounted) return;
        if (models && models.length > 0) {
          setDiscoveredModels(models);
          if (!modelBuffer.text.trim()) {
            modelBuffer.setText(models[0]);
          }
        }
      },
    );

    return () => {
      isMounted = false;
    };
  }, [urlBuffer.text, keyBuffer.text, modelBuffer]);

  useKeypress(
    (key) => {
      if (key.name === 'tab') {
        setActiveField((f) => {
          if (f === 'url') return 'key';
          if (f === 'key') return 'model';
          return 'url';
        });
        return true;
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (activeField === 'url') {
          setActiveField('key');
          return true;
        }
        if (activeField === 'key') {
          setActiveField('model');
          return true;
        }
        onSubmit(urlBuffer.text, keyBuffer.text, modelBuffer.text);
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
          Connect to a remote or local vLLM server hosting any model.
        </Text>
        <Text color={theme.text.secondary}>
          Compatible with any model (e.g. Llama, Qwen, Mistral, Gemma, or local
          weights) via OpenAI or Gemini protocol.
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
            onSubmit={() => setActiveField('model')}
            onCancel={onCancel}
            placeholder="Leave empty if not required"
            focus={activeField === 'key'}
          />
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.primary}>
          Model Name (optional / auto-detected):
        </Text>
        <Box
          borderStyle="round"
          borderColor={
            activeField === 'model' ? theme.ui.focus : theme.border.default
          }
          paddingX={1}
        >
          <TextInput
            buffer={modelBuffer}
            onSubmit={() =>
              onSubmit(urlBuffer.text, keyBuffer.text, modelBuffer.text)
            }
            onCancel={onCancel}
            placeholder="e.g. Qwen/Qwen2.5-Coder-32B-Instruct, meta-llama/Llama-3.1-8B-Instruct"
            focus={activeField === 'model'}
          />
        </Box>
        {discoveredModels.length > 0 && (
          <Box marginTop={0.5}>
            <Text color={theme.text.accent}>
              Available on server: {discoveredModels.join(', ')}
            </Text>
          </Box>
        )}
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
