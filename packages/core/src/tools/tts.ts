/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Modality, type SpeechConfig, type VoiceConfig } from '@google/genai';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { LlmRole } from '../telemetry/llmRole.js';
import { getPromptIdWithFallback } from '../utils/promptIdContext.js';
import { getErrorMessage, isAbortError, isNodeError } from '../utils/errors.js';
import { debugLogger } from '../utils/debugLogger.js';
import {
  isSubpath,
  resolveDefensiveToolPath,
  resolveToRealPath,
} from '../utils/paths.js';
import { ToolErrorType } from './tool-error.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ExecuteOptions,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';

/**
 * Speech synthesis runs on Google's own TTS models through `@google/genai`.
 *
 * Not ported from omp, on purpose:
 * - the xAI and DeepInfra speech backends would introduce third-party model
 *   providers, which this repository does not allow;
 * - the local Kokoro ONNX path would require a model download plus an ONNX
 *   runtime dependency that this repository does not have. Google's cloud TTS
 *   is the whole feature here.
 */

/** Wall-clock budget for a single synthesis request. */
const TTS_TIMEOUT_MS = 60 * 1000;

/** Upper bound on the synthesizable text length, in characters. */
export const TTS_MAX_TEXT_LENGTH = 15000;

/** Default voice used when the caller does not pick one. */
export const DEFAULT_TTS_VOICE = 'Kore';

/**
 * Default model used when the integrator does not wire a `tts` model-config
 * alias. Callers should pass the alias-resolved model name as the third
 * constructor argument.
 */
export const DEFAULT_TTS_MODEL = 'gemini-2.5-flash-preview-tts';

/**
 * Parameters for the TtsTool.
 */
export interface TtsParams {
  /** Text to synthesize. 1 to 15000 characters. */
  text: string;
  /** Prebuilt voice name. Google defaults this when omitted. */
  voice_id?: string;
  /** ISO 639 language code, e.g. `en` or `en-US`. */
  language?: string;
  /** Destination path, absolute or relative to the workspace root. */
  output_path: string;
  /**
   * Accepted for portability with omp's provider-neutral schema. Google's
   * speech API fixes its output rate, so this value is validated but not sent.
   */
  sample_rate?: number;
}

const TTS_DESCRIPTION = `Synthesizes speech from text with Google's text-to-speech models and writes the audio to a file.

\`text\` must be 1 to 15000 characters. \`output_path\` must resolve inside the workspace;
missing parent directories are created. \`language\` is an ISO 639 code and defaults to \`en\`.
\`voice_id\` selects a prebuilt voice (for example \`Kore\`, \`Puck\`, \`Charon\`); omit it to use
the model default.`;

const TTS_PARAMETERS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      maxLength: TTS_MAX_TEXT_LENGTH,
      description: 'Text to synthesize.',
    },
    voice_id: {
      type: 'string',
      description: 'Prebuilt voice name.',
    },
    language: {
      type: 'string',
      description: 'ISO 639 language code, e.g. "en" or "en-US".',
    },
    output_path: {
      type: 'string',
      description: 'Destination path for the generated audio file.',
    },
    sample_rate: {
      type: 'number',
      description: 'Sample rate override; ignored by the Google backend.',
    },
  },
  required: ['text', 'output_path'],
};

/**
 * Outcome of resolving an agent-supplied output path.
 */
export type ResolvedOutputPath =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Resolves an agent-supplied output path against the workspace root, the same
 * way `write_file` does, and refuses anything that escapes the workspace.
 *
 * Exported as a pure function so the containment rule is testable without a
 * `Config`.
 */
export function resolveWorkspaceOutputPath(
  targetDir: string,
  outputPath: string,
): ResolvedOutputPath {
  if (!outputPath || outputPath.trim() === '') {
    return { ok: false, reason: 'The output path cannot be empty.' };
  }
  if (outputPath.includes('\0')) {
    return { ok: false, reason: 'The output path contains a null byte.' };
  }

  const sanitized = resolveDefensiveToolPath(outputPath, targetDir);
  const resolved = resolveToRealPath(path.resolve(targetDir, sanitized));
  const realRoot = resolveToRealPath(targetDir);

  if (!isSubpath(realRoot, resolved)) {
    return {
      ok: false,
      reason: `The output path "${outputPath}" resolves outside the workspace.`,
    };
  }
  return { ok: true, path: resolved };
}

/**
 * Builds the `speechConfig` for a synthesis request. Exported so the mapping
 * from tool params to the SDK shape is directly testable.
 */
export function buildSpeechConfig(params: TtsParams): SpeechConfig {
  const speechConfig: SpeechConfig = {
    languageCode: params.language ?? 'en',
  };
  if (params.voice_id) {
    const voiceConfig: VoiceConfig = {
      prebuiltVoiceConfig: { voiceName: params.voice_id },
    };
    speechConfig.voiceConfig = voiceConfig;
  }
  return speechConfig;
}

class TtsToolInvocation extends BaseToolInvocation<TtsParams, ToolResult> {
  constructor(
    private readonly config: Config,
    private readonly modelName: string,
    params: TtsParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(
      params,
      messageBus,
      toolName,
      toolDisplayName,
      undefined,
      undefined,
      false,
      () => this.config.getApprovalMode(),
    );
  }

  override getDescription(): string {
    return `Synthesizing ${this.params.text.length} characters of speech to ${this.params.output_path}`;
  }

  async execute({ abortSignal }: ExecuteOptions): Promise<ToolResult> {
    const timeoutSignal = AbortSignal.timeout(TTS_TIMEOUT_MS);
    const signal = AbortSignal.any([abortSignal, timeoutSignal]);

    try {
      const resolution = resolveWorkspaceOutputPath(
        this.config.getTargetDir(),
        this.params.output_path,
      );
      if (!resolution.ok) {
        return {
          llmContent: resolution.reason,
          returnDisplay: 'Error: invalid output path.',
          error: {
            message: resolution.reason,
            type: ToolErrorType.PATH_NOT_IN_WORKSPACE,
          },
        };
      }
      const outputPath = resolution.path;

      const accessError = this.config.validatePathAccess(outputPath, 'write');
      if (accessError) {
        return {
          llmContent: accessError,
          returnDisplay: 'Error: path not in workspace.',
          error: {
            message: accessError,
            type: ToolErrorType.PATH_NOT_IN_WORKSPACE,
          },
        };
      }

      const response = await this.config.getContentGenerator().generateContent(
        {
          model: this.modelName,
          contents: [{ role: 'user', parts: [{ text: this.params.text }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: buildSpeechConfig(this.params),
            abortSignal: signal,
            httpOptions: { timeout: TTS_TIMEOUT_MS },
          },
        },
        getPromptIdWithFallback('tts'),
        LlmRole.UTILITY_TOOL,
      );

      const responseParts = response.candidates?.[0]?.content?.parts ?? [];
      let audioData: string | undefined;
      let audioMimeType: string | undefined;
      for (const part of responseParts) {
        const inline = part.inlineData;
        if (inline?.data && !audioData) {
          audioData = inline.data;
          audioMimeType = inline.mimeType;
        }
      }

      if (!audioData) {
        const message = 'Speech synthesis returned no audio data.';
        return {
          llmContent: message,
          returnDisplay: 'No audio generated.',
          error: { message, type: ToolErrorType.EXECUTION_FAILED },
        };
      }

      const bytes = Buffer.from(audioData, 'base64');
      await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
      await fsPromises.writeFile(outputPath, bytes);

      const mimeSuffix = audioMimeType ? ` (${audioMimeType})` : '';
      const summary = `Saved ${bytes.byteLength} bytes of audio to ${outputPath}${mimeSuffix} with ${this.modelName}.`;

      return {
        llmContent: summary,
        returnDisplay: `Saved audio to ${path.basename(outputPath)}`,
        data: {
          bytes: bytes.byteLength,
          outputPath,
          model: this.modelName,
        },
      };
    } catch (error: unknown) {
      if (isAbortError(error)) {
        const timedOut = abortSignal.aborted === false;
        const message = timedOut
          ? `Speech synthesis timed out after ${TTS_TIMEOUT_MS}ms.`
          : 'Speech synthesis was cancelled.';
        return {
          llmContent: message,
          returnDisplay: timedOut
            ? 'Speech synthesis timed out.'
            : 'Cancelled.',
          error: { message, type: ToolErrorType.EXECUTION_FAILED },
        };
      }

      const message = `Speech synthesis failed: ${getErrorMessage(error)}`;
      debugLogger.warn(message, error);
      return {
        llmContent: message,
        returnDisplay: 'Error synthesizing speech.',
        error: {
          message,
          type:
            isNodeError(error) && error.code === 'ENOENT'
              ? ToolErrorType.FILE_NOT_FOUND
              : ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

/**
 * Synthesizes speech with Google's TTS models and writes the audio to a file.
 *
 * The model name is taken from the constructor, never from user settings, so
 * the integrator can wire the `tts` model-config alias.
 */
export class TtsTool extends BaseDeclarativeTool<TtsParams, ToolResult> {
  static readonly Name = 'tts';

  static readonly Description = TTS_DESCRIPTION;

  private readonly modelName: string;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
    modelName: string = DEFAULT_TTS_MODEL,
  ) {
    super(
      TtsTool.Name,
      'Text to Speech',
      TtsTool.Description,
      Kind.Execute,
      TTS_PARAMETERS_JSON_SCHEMA,
      messageBus,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
    this.modelName = modelName;
  }

  /** The model this tool instance was constructed with. */
  getModelName(): string {
    return this.modelName;
  }

  protected override validateToolParamValues(params: TtsParams): string | null {
    if (!params.text || params.text.trim() === '') {
      return "The 'text' parameter is required and cannot be empty.";
    }
    if (params.text.length > TTS_MAX_TEXT_LENGTH) {
      return `The 'text' parameter must be at most ${TTS_MAX_TEXT_LENGTH} characters (got ${params.text.length}).`;
    }
    if (!params.output_path || params.output_path.trim() === '') {
      return "The 'output_path' parameter is required and cannot be empty.";
    }
    if (
      params.sample_rate !== undefined &&
      (!Number.isInteger(params.sample_rate) || params.sample_rate <= 0)
    ) {
      return "The 'sample_rate' parameter must be a positive integer.";
    }
    if (params.voice_id !== undefined && params.voice_id.trim() === '') {
      return "The 'voice_id' parameter cannot be an empty string; omit it instead.";
    }
    if (params.language !== undefined && params.language.trim() === '') {
      return "The 'language' parameter cannot be an empty string; omit it instead.";
    }
    return null;
  }

  protected createInvocation(
    params: TtsParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<TtsParams, ToolResult> {
    return new TtsToolInvocation(
      this.config,
      this.modelName,
      params,
      messageBus,
      toolName,
      toolDisplayName,
    );
  }
}
