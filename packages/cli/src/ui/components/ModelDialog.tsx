/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useContext, useMemo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { ModelQuotaDisplay } from './ModelQuotaDisplay.js';
import { useUIState } from '../contexts/UIStateContext.js';
import {
  PREVIEW_GEMINI_MODEL,
  PREVIEW_GEMINI_3_1_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_3_5_FLASH_MODEL,
  DEFAULT_GEMINI_3_6_FLASH_MODEL,
  DEFAULT_GEMINI_3_7_FLASH_MODEL,
  DEFAULT_GEMINI_3_8_FLASH_MODEL,
  GEMINI_MODEL_ALIAS_AUTO,
  GEMMA_4_31B_IT_MODEL,
  GEMMA_4_26B_A4B_IT_MODEL,
  ModelSlashCommandEvent,
  logModelSlashCommand,
  getDisplayString,
  AuthType,
  PREVIEW_GEMINI_3_1_CUSTOM_TOOLS_MODEL,
  isProModel,
  getAutoModelDescription,
  isCustomModel,
  fetchVllmModels,
} from '@google/gemini-cli-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';

interface ModelDialogProps {
  onClose: () => void;
}

export function ModelDialog({ onClose }: ModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);
  const settings = useSettings();
  const { terminalWidth } = useUIState();
  const [hasAccessToProModel, setHasAccessToProModel] = useState<boolean>(
    () => !(config?.getProModelNoAccessSync() ?? false),
  );
  const [view, setView] = useState<'main' | 'manual'>(() =>
    config?.getProModelNoAccessSync() ? 'manual' : 'main',
  );
  const [persistMode, setPersistMode] = useState(false);

  useEffect(() => {
    async function checkAccess() {
      if (!config) return;
      const noAccess = await config.getProModelNoAccess();
      setHasAccessToProModel(!noAccess);
      if (noAccess) {
        setView('manual');
      }
    }
    void checkAccess();
  }, [config]);

  const [vllmModels, setVllmModels] = useState<string[]>([]);

  useEffect(() => {
    const isVllm =
      config?.getContentGeneratorConfig?.()?.authType === AuthType.USE_VLLM ||
      Boolean(process.env['VLLM_BASE_URL']);
    if (isVllm) {
      const baseUrl =
        config?.getContentGeneratorConfig?.()?.baseUrl ||
        process.env['VLLM_BASE_URL'] ||
        'http://localhost:8000';
      const apiKey =
        config?.getContentGeneratorConfig?.()?.apiKey ||
        process.env['VLLM_API_KEY'];
      void fetchVllmModels(baseUrl, apiKey).then((models: string[]) => {
        if (models && models.length > 0) {
          setVllmModels(models);
        }
      });
    }
  }, [config]);

  // Determine the Preferred Model (read once when the dialog opens).
  const preferredModel = config?.getModel() || GEMINI_MODEL_ALIAS_AUTO;

  const shouldShowPreviewModels = config?.getHasAccessToPreviewModel() ?? false;
  const useGemini31 = config?.getGemini31LaunchedSync?.() ?? false;
  const useGemini3_5Flash = config?.hasGemini35FlashGAAccess?.() ?? false;
  const useGemini3_6Flash = config?.hasGemini36FlashGAAccess?.() ?? false;
  const useGemini3_7Flash = config?.hasGemini37FlashGAAccess?.() ?? false;
  const useGemini3_8Flash = config?.hasGemini38FlashGAAccess?.() ?? false;
  const selectedAuthType = settings.merged.security.auth.selectedType;
  const useCustomToolModel =
    useGemini31 && selectedAuthType === AuthType.USE_GEMINI;

  const manualModelSelected = useMemo(() => {
    if (
      config?.getExperimentalDynamicModelConfiguration?.() === true &&
      config.getModelConfigService
    ) {
      const def = config
        .getModelConfigService()
        .getModelDefinition(preferredModel);
      // Only treat as manual selection if it's a visible, non-auto model, or custom model.
      return def &&
        def.tier !== 'auto' &&
        (def.isVisible === true || def.tier === 'custom')
        ? preferredModel
        : '';
    }

    const manualModels = [
      DEFAULT_GEMINI_MODEL,
      DEFAULT_GEMINI_FLASH_MODEL,
      DEFAULT_GEMINI_3_5_FLASH_MODEL,
      DEFAULT_GEMINI_3_6_FLASH_MODEL,
      DEFAULT_GEMINI_3_7_FLASH_MODEL,
      DEFAULT_GEMINI_3_8_FLASH_MODEL,
      DEFAULT_GEMINI_FLASH_LITE_MODEL,
      PREVIEW_GEMINI_MODEL,
      PREVIEW_GEMINI_3_1_MODEL,
      PREVIEW_GEMINI_3_1_CUSTOM_TOOLS_MODEL,
      PREVIEW_GEMINI_FLASH_LITE_MODEL,
      PREVIEW_GEMINI_FLASH_MODEL,
    ].filter((m) => m !== 'none');
    if (
      manualModels.includes(preferredModel) ||
      (preferredModel && isCustomModel(preferredModel, config ?? undefined)) ||
      vllmModels.includes(preferredModel)
    ) {
      return preferredModel;
    }
    return '';
  }, [preferredModel, config, vllmModels]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (view === 'manual' && hasAccessToProModel) {
          setView('main');
        } else {
          onClose();
        }
        return true;
      }
      if (key.name === 'tab') {
        setPersistMode((prev) => !prev);
        return true;
      }
      return false;
    },
    { isActive: true },
  );
  const mainOptions = useMemo(() => {
    // --- DYNAMIC PATH ---
    if (
      config?.getExperimentalDynamicModelConfiguration?.() === true &&
      config.getModelConfigService
    ) {
      const allOptions = config
        .getModelConfigService()
        .getAvailableModelOptions({
          useGemini3_1: useGemini31,
          useGemini3_5Flash,
          useGemini3_6Flash,
          useGemini3_7Flash,
          useGemini3_8Flash,
          useCustomTools: useCustomToolModel,
          hasAccessToPreview: shouldShowPreviewModels,
          hasAccessToProModel,
        });

      const list = allOptions
        .filter((o) => o.tier === 'auto')
        .map((o) => ({
          value: o.modelId,
          title: o.name,
          description: o.description,
          key: o.modelId,
        }));

      list.push({
        value: 'Manual',
        title: manualModelSelected
          ? `Manual (${getDisplayString(manualModelSelected, config ?? undefined)})`
          : 'Manual',
        description: 'Manually select a model',
        key: 'Manual',
      });
      return list;
    }

    // --- LEGACY PATH ---
    const list = [
      {
        value: GEMINI_MODEL_ALIAS_AUTO,
        title: getDisplayString(GEMINI_MODEL_ALIAS_AUTO),
        description: getAutoModelDescription(
          shouldShowPreviewModels,
          useGemini31,
          useGemini3_5Flash,
          useGemini3_6Flash,
          useGemini3_7Flash,
          useGemini3_8Flash,
        ),
        key: GEMINI_MODEL_ALIAS_AUTO,
      },
      {
        value: 'Manual',
        title: manualModelSelected
          ? `Manual (${getDisplayString(manualModelSelected)})`
          : 'Manual',
        description: 'Manually select a model',
        key: 'Manual',
      },
    ];

    return list;
  }, [
    config,
    shouldShowPreviewModels,
    manualModelSelected,
    useGemini31,
    useGemini3_5Flash,
    useGemini3_6Flash,
    useGemini3_7Flash,
    useGemini3_8Flash,
    useCustomToolModel,
    hasAccessToProModel,
  ]);

  const manualOptions = useMemo(() => {
    // --- DYNAMIC PATH ---
    if (
      config?.getExperimentalDynamicModelConfiguration?.() === true &&
      config.getModelConfigService
    ) {
      const allOptions = config
        .getModelConfigService()
        .getAvailableModelOptions({
          useGemini3_1: useGemini31,
          useGemini3_5Flash,
          useGemini3_6Flash,
          useGemini3_7Flash,
          useGemini3_8Flash,
          useCustomTools: useCustomToolModel,
          hasAccessToPreview: shouldShowPreviewModels,
          hasAccessToProModel,
        });

      const opts = allOptions
        .filter((o) => o.tier !== 'auto')
        .map((o) => ({
          value: o.modelId,
          title: o.name,
          key: o.modelId,
        }));

      for (const m of vllmModels) {
        if (
          m &&
          m !== GEMINI_MODEL_ALIAS_AUTO &&
          !opts.some((o) => o.value === m)
        ) {
          opts.unshift({
            value: m,
            title: getDisplayString(m, config ?? undefined),
            key: m,
          });
        }
      }

      if (
        process.env['VLLM_MODEL']?.trim() &&
        process.env['VLLM_MODEL'] !== GEMINI_MODEL_ALIAS_AUTO &&
        !opts.some((o) => o.value === process.env['VLLM_MODEL'])
      ) {
        const vm = process.env['VLLM_MODEL'];
        opts.unshift({
          value: vm,
          title: getDisplayString(vm, config ?? undefined),
          key: vm,
        });
      }

      if (
        preferredModel &&
        preferredModel !== GEMINI_MODEL_ALIAS_AUTO &&
        isCustomModel(preferredModel, config ?? undefined) &&
        !opts.some((o) => o.value === preferredModel)
      ) {
        opts.unshift({
          value: preferredModel,
          title: getDisplayString(preferredModel, config ?? undefined),
          key: preferredModel,
        });
      }

      return opts;
    }

    // --- LEGACY PATH ---
    const showGemmaModels = config?.getExperimentalGemma() ?? false;

    const options = [
      {
        value: DEFAULT_GEMINI_MODEL,
        title: getDisplayString(DEFAULT_GEMINI_MODEL),
        key: DEFAULT_GEMINI_MODEL,
      },
      {
        value: DEFAULT_GEMINI_FLASH_LITE_MODEL,
        title: getDisplayString(DEFAULT_GEMINI_FLASH_LITE_MODEL),
        key: DEFAULT_GEMINI_FLASH_LITE_MODEL,
      },
    ];

    if (useGemini3_8Flash) {
      options.push({
        value: DEFAULT_GEMINI_3_8_FLASH_MODEL,
        title: getDisplayString(DEFAULT_GEMINI_3_8_FLASH_MODEL),
        key: DEFAULT_GEMINI_3_8_FLASH_MODEL,
      });
    }

    if (useGemini3_7Flash) {
      options.push({
        value: DEFAULT_GEMINI_3_7_FLASH_MODEL,
        title: getDisplayString(DEFAULT_GEMINI_3_7_FLASH_MODEL),
        key: DEFAULT_GEMINI_3_7_FLASH_MODEL,
      });
    }

    if (useGemini3_6Flash) {
      options.push({
        value: DEFAULT_GEMINI_3_6_FLASH_MODEL,
        title: getDisplayString(DEFAULT_GEMINI_3_6_FLASH_MODEL),
        key: DEFAULT_GEMINI_3_6_FLASH_MODEL,
      });
    }

    if (useGemini3_5Flash) {
      options.push({
        value: DEFAULT_GEMINI_3_5_FLASH_MODEL,
        title: getDisplayString(DEFAULT_GEMINI_3_5_FLASH_MODEL),
        key: DEFAULT_GEMINI_3_5_FLASH_MODEL,
      });
    }

    options.push({
      value: DEFAULT_GEMINI_FLASH_MODEL,
      title: getDisplayString(DEFAULT_GEMINI_FLASH_MODEL),
      key: DEFAULT_GEMINI_FLASH_MODEL,
    });

    if (showGemmaModels) {
      options.push(
        {
          value: GEMMA_4_31B_IT_MODEL,
          title: getDisplayString(GEMMA_4_31B_IT_MODEL),
          key: GEMMA_4_31B_IT_MODEL,
        },
        {
          value: GEMMA_4_26B_A4B_IT_MODEL,
          title: getDisplayString(GEMMA_4_26B_A4B_IT_MODEL),
          key: GEMMA_4_26B_A4B_IT_MODEL,
        },
      );
    }

    if (shouldShowPreviewModels) {
      const previewProModel = useGemini31
        ? PREVIEW_GEMINI_3_1_MODEL
        : PREVIEW_GEMINI_MODEL;

      const previewProValue = useCustomToolModel
        ? PREVIEW_GEMINI_3_1_CUSTOM_TOOLS_MODEL
        : previewProModel;

      const previewOptions = [
        {
          value: previewProValue,
          title: getDisplayString(previewProModel),
          key: previewProModel,
        },
        {
          value: PREVIEW_GEMINI_FLASH_MODEL,
          title: getDisplayString(PREVIEW_GEMINI_FLASH_MODEL),
          key: PREVIEW_GEMINI_FLASH_MODEL,
        },
      ];

      if (PREVIEW_GEMINI_FLASH_LITE_MODEL !== 'none') {
        previewOptions.push({
          value: PREVIEW_GEMINI_FLASH_LITE_MODEL,
          title: getDisplayString(PREVIEW_GEMINI_FLASH_LITE_MODEL),
          key: PREVIEW_GEMINI_FLASH_LITE_MODEL,
        });
      }

      options.unshift(...previewOptions);
    }

    for (const m of vllmModels) {
      if (
        m &&
        m !== GEMINI_MODEL_ALIAS_AUTO &&
        !options.some((o) => o.value === m)
      ) {
        options.unshift({
          value: m,
          title: getDisplayString(m, config ?? undefined),
          key: m,
        });
      }
    }

    if (
      process.env['VLLM_MODEL']?.trim() &&
      process.env['VLLM_MODEL'] !== GEMINI_MODEL_ALIAS_AUTO &&
      !options.some((o) => o.value === process.env['VLLM_MODEL'])
    ) {
      const vm = process.env['VLLM_MODEL'];
      options.unshift({
        value: vm,
        title: getDisplayString(vm, config ?? undefined),
        key: vm,
      });
    }

    if (
      preferredModel &&
      preferredModel !== GEMINI_MODEL_ALIAS_AUTO &&
      isCustomModel(preferredModel, config ?? undefined) &&
      !options.some((o) => o.value === preferredModel)
    ) {
      options.unshift({
        value: preferredModel,
        title: getDisplayString(preferredModel, config ?? undefined),
        key: preferredModel,
      });
    }

    if (!hasAccessToProModel) {
      // Filter out all Pro models for free tier
      return options.filter((option) => !isProModel(option.value));
    }

    return options;
  }, [
    shouldShowPreviewModels,
    useGemini31,
    useGemini3_5Flash,
    useGemini3_6Flash,
    useGemini3_7Flash,
    useGemini3_8Flash,
    useCustomToolModel,
    hasAccessToProModel,
    config,
    vllmModels,
    preferredModel,
  ]);

  const options = useMemo(() => {
    const rawOptions = view === 'main' ? mainOptions : manualOptions;
    const seen = new Set<string>();
    return rawOptions.filter((option) => {
      if (seen.has(option.value)) {
        return false;
      }
      seen.add(option.value);
      return true;
    });
  }, [view, mainOptions, manualOptions]);

  // Calculate the initial index based on the preferred model.
  const initialIndex = useMemo(() => {
    const idx = options.findIndex((option) => option.value === preferredModel);
    if (idx !== -1) {
      return idx;
    }
    if (view === 'main') {
      const manualIdx = options.findIndex((o) => o.value === 'Manual');
      return manualIdx !== -1 ? manualIdx : 0;
    }
    return 0;
  }, [preferredModel, options, view]);

  // Handle selection internally (Autonomous Dialog).
  const handleSelect = useCallback(
    (model: string) => {
      if (model === 'Manual') {
        setView('manual');
        return;
      }

      if (config) {
        config.setModel(model, persistMode ? false : true);
        const event = new ModelSlashCommandEvent(model);
        logModelSlashCommand(config, event);
      }
      onClose();
    },
    [config, onClose, persistMode],
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>Select Model</Text>

      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={options}
          onSelect={handleSelect}
          initialIndex={initialIndex}
          showNumbers={true}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text bold color={theme.text.primary}>
            Remember model for future sessions:{' '}
          </Text>
          <Text color={theme.status.success}>
            {persistMode ? 'true' : 'false'}
          </Text>
          <Text color={theme.text.secondary}> (Press Tab to toggle)</Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          {'> To use a specific Gemini model on startup, use the --model flag.'}
        </Text>
      </Box>
      <ModelQuotaDisplay
        buckets={config?.getLastRetrievedQuota()?.buckets}
        availableWidth={terminalWidth - 2}
      />
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>(Press Esc to close)</Text>
      </Box>
    </Box>
  );
}
