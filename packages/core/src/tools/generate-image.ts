/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Modality, type Part } from '@google/genai';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { LlmRole } from '../telemetry/llmRole.js';
import { getPromptIdWithFallback } from '../utils/promptIdContext.js';
import { getErrorMessage, isAbortError, isNodeError } from '../utils/errors.js';
import { debugLogger } from '../utils/debugLogger.js';
import {
  resolveDefensiveToolPath,
  resolveToRealPath,
  tmpdir,
} from '../utils/paths.js';
import { getSpecificMimeType } from '../utils/fileUtils.js';
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
 * Image generation runs on Google's own image-capable Gemini models through
 * `@google/genai`. No third-party image provider is involved.
 *
 * omp's OpenAI / xAI / DeepInfra image transports are intentionally NOT ported:
 * this repository keeps Gemini as the only backend.
 */

/** Wall-clock budget for a single image generation request. */
const GENERATE_IMAGE_TIMEOUT_MS = 3 * 60 * 1000;

/** Hard cap on the size of a single input image (35 MiB). */
const MAX_INPUT_IMAGE_BYTES = 35 * 1024 * 1024;

/**
 * Default model used when the integrator does not wire a `generate-image`
 * model-config alias. Callers should pass the alias-resolved model name as the
 * third constructor argument.
 */
export const DEFAULT_GENERATE_IMAGE_MODEL = 'gemini-2.5-flash-image';

/**
 * Aspect ratios accepted by the tool. Every value here is also a value the
 * Gemini `imageConfig.aspectRatio` field accepts.
 */
const ASPECT_RATIOS: Record<string, true> = {
  '1:1': true,
  '3:4': true,
  '4:3': true,
  '9:16': true,
  '16:9': true,
  '3:2': true,
  '2:3': true,
};

export type GenerateImageAspectRatio = keyof typeof ASPECT_RATIOS;

/**
 * Explicit output dimensions. The Gemini image API takes a resolution tier
 * ("1K" / "2K" / "4K") instead of pixel dimensions, so each accepted dimension
 * maps onto the tier that produces it.
 */
const IMAGE_SIZES: Record<string, true> = {
  '1024x1024': true,
  '1536x1024': true,
  '1024x1536': true,
};

export type GenerateImageSize = keyof typeof IMAGE_SIZES;

const IMAGE_SIZE_TO_TIER: Record<GenerateImageSize, string> = {
  '1024x1024': '1K',
  '1536x1024': '2K',
  '1024x1536': '2K',
};

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function isGenerateImageAspectRatio(
  value: unknown,
): value is GenerateImageAspectRatio {
  return typeof value === 'string' && Object.hasOwn(ASPECT_RATIOS, value);
}

function isGenerateImageSize(value: unknown): value is GenerateImageSize {
  return typeof value === 'string' && Object.hasOwn(IMAGE_SIZES, value);
}

/**
 * An image supplied as a reference or an edit source.
 */
export interface GenerateImageInput {
  /** Path to the image, absolute or relative to the workspace root. */
  path: string;
  /** Optional MIME type; inferred from the file extension when omitted. */
  mime_type?: string;
}

/**
 * Parameters for the GenerateImage tool.
 */
export interface GenerateImageParams {
  /** The main subject of the image. Required. */
  subject: string;
  /** What the subject is doing. */
  action?: string;
  /** Location or environment the scene takes place in. */
  scene?: string;
  /** Camera angle and framing. */
  composition?: string;
  /** Lighting setup. */
  lighting?: string;
  /** Artistic style. */
  style?: string;
  /** Text to render inside the image. Keep it short. */
  text?: string;
  /** Edits to apply to the supplied input images. */
  changes?: string[];
  /** Output aspect ratio. */
  aspect_ratio?: GenerateImageAspectRatio;
  /** Output dimensions. */
  image_size?: GenerateImageSize;
  /** Reference or edit-source images. */
  input?: GenerateImageInput[];
}

const GENERATE_IMAGE_DESCRIPTION = `Generates or edits images with Google's image generation models.

Provide a detailed \`subject\` plus any of \`action\`, \`scene\`, \`composition\`, \`lighting\` and \`style\`.
Pass \`input\` images to edit them, and describe the edits in \`changes\`; when several images are
supplied, identify each one's role in \`subject\` (for example, "Image 1 composition; Image 2
lighting"). Use \`text\` only for short strings that must render sharply and legibly. The result is
written to a temporary file and returned inline.`;

/**
 * Minimal parameter schema. The integrator owns the shared tool declarations in
 * `tools/definitions/**`; override `getSchema()` to point at that declaration.
 */
const GENERATE_IMAGE_PARAMETERS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'Main subject of the image.' },
    action: { type: 'string', description: 'What the subject is doing.' },
    scene: {
      type: 'string',
      description: 'Location or environment of the scene.',
    },
    composition: {
      type: 'string',
      description: 'Camera angle and framing.',
    },
    lighting: { type: 'string', description: 'Lighting setup.' },
    style: { type: 'string', description: 'Artistic style.' },
    text: { type: 'string', description: 'Text to render in the image.' },
    changes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Edits to apply to the supplied input images.',
    },
    aspect_ratio: {
      type: 'string',
      enum: Object.keys(ASPECT_RATIOS),
      description: 'Output aspect ratio.',
    },
    image_size: {
      type: 'string',
      enum: Object.keys(IMAGE_SIZES),
      description: 'Output dimensions.',
    },
    input: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the input image.' },
          mime_type: {
            type: 'string',
            description: 'MIME type of the input image.',
          },
        },
        required: ['path'],
      },
      description: 'Reference or edit-source images.',
    },
  },
  required: ['subject'],
};

/**
 * Composes the decomposed prompt fields into a single natural-language prompt.
 * Decomposing the request measurably improves image prompting and is
 * provider-neutral, so the exact same prompt is produced here for any backend.
 */
export function composeImagePrompt(params: GenerateImageParams): string {
  const parts: string[] = [];

  const subjectParts = [params.subject];
  if (params.action) {
    subjectParts.push(params.action);
  }
  if (params.scene) {
    subjectParts.push(params.scene);
  }
  parts.push(subjectParts.join(', '));

  if (params.composition) {
    parts.push(params.composition);
  }
  if (params.lighting) {
    parts.push(params.lighting);
  }
  if (params.style) {
    parts.push(params.style);
  }

  let prompt = `${parts.map((part) => part.replace(/[.!,;:]+$/, '')).join('. ')}.`;

  if (params.text) {
    prompt += `\n\nText: ${params.text}`;
  }
  if (params.changes?.length) {
    prompt += `\n\nChanges:\n${params.changes.map((c) => `- ${c}`).join('\n')}`;
  }
  return prompt;
}

/**
 * Picks the on-disk extension for a generated image MIME type.
 */
export function imageExtensionFor(mimeType: string): string {
  return IMAGE_EXTENSIONS[mimeType] ?? 'png';
}

interface LoadedInputImage {
  data: string;
  mimeType: string;
}

class GenerateImageToolInvocation extends BaseToolInvocation<
  GenerateImageParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    private readonly modelName: string,
    params: GenerateImageParams,
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
    return `Generating an image of "${this.params.subject}"`;
  }

  private async loadInputImage(
    input: GenerateImageInput,
  ): Promise<LoadedInputImage> {
    const sanitized = resolveDefensiveToolPath(
      input.path,
      this.config.getTargetDir(),
    );
    const resolved = resolveToRealPath(
      path.resolve(this.config.getTargetDir(), sanitized),
    );

    const accessError = this.config.validatePathAccess(resolved, 'read');
    if (accessError) {
      throw new Error(`Cannot read input image: ${accessError}`);
    }

    const bytes = await fsPromises.readFile(resolved);
    if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES) {
      throw new Error(
        `Input image exceeds the ${MAX_INPUT_IMAGE_BYTES}-byte limit: ${input.path}`,
      );
    }

    const mimeType = input.mime_type ?? getSpecificMimeType(resolved);
    if (!mimeType || !mimeType.startsWith('image/')) {
      throw new Error(
        `Unsupported input image type for "${input.path}". Provide mime_type explicitly.`,
      );
    }

    return { data: bytes.toString('base64'), mimeType };
  }

  private buildImageConfig(): Record<string, string> | undefined {
    if (
      this.params.aspect_ratio === undefined &&
      this.params.image_size === undefined
    ) {
      return undefined;
    }
    const imageConfig: Record<string, string> = {};
    if (this.params.aspect_ratio !== undefined) {
      imageConfig['aspectRatio'] = this.params.aspect_ratio;
    }
    if (this.params.image_size !== undefined) {
      imageConfig['imageSize'] = IMAGE_SIZE_TO_TIER[this.params.image_size];
    }
    return imageConfig;
  }

  async execute({ abortSignal }: ExecuteOptions): Promise<ToolResult> {
    const prompt = composeImagePrompt(this.params);
    debugLogger.debug(
      `[GenerateImageTool] model=${this.modelName} prompt=${prompt}`,
    );

    const timeoutSignal = AbortSignal.timeout(GENERATE_IMAGE_TIMEOUT_MS);
    const signal = AbortSignal.any([abortSignal, timeoutSignal]);

    try {
      const inputImages: LoadedInputImage[] = [];
      for (const input of this.params.input ?? []) {
        inputImages.push(await this.loadInputImage(input));
      }

      const requestParts: Part[] = [
        ...inputImages.map((image) => ({
          inlineData: { mimeType: image.mimeType, data: image.data },
        })),
        { text: prompt },
      ];

      const imageConfig = this.buildImageConfig();

      const response = await this.config.getContentGenerator().generateContent(
        {
          model: this.modelName,
          contents: [{ role: 'user', parts: requestParts }],
          config: {
            responseModalities: [Modality.IMAGE],
            ...(imageConfig ? { imageConfig } : {}),
            abortSignal: signal,
            httpOptions: { timeout: GENERATE_IMAGE_TIMEOUT_MS },
          },
        },
        getPromptIdWithFallback('generate-image'),
        LlmRole.UTILITY_TOOL,
      );

      const responseParts = response.candidates?.[0]?.content?.parts ?? [];
      const inlineParts: Part[] = [];
      const notes: string[] = [];

      for (const part of responseParts) {
        const inline = part.inlineData;
        if (inline?.data && inline.mimeType?.startsWith('image/')) {
          inlineParts.push({
            inlineData: { mimeType: inline.mimeType, data: inline.data },
          });
        } else if (part.text) {
          notes.push(part.text);
        }
      }

      if (inlineParts.length === 0) {
        const detail =
          notes.length > 0 ? ` Model said: ${notes.join(' ')}` : '';
        const message = `Image generation returned no image.${detail}`;
        return {
          llmContent: message,
          returnDisplay: 'No image generated.',
          error: { message, type: ToolErrorType.EXECUTION_FAILED },
        };
      }

      const savedPaths: string[] = [];
      for (const part of inlineParts) {
        const inline = part.inlineData;
        if (!inline?.data || !inline.mimeType) {
          continue;
        }
        const filePath = path.join(
          tmpdir(),
          `gemini-image-${randomUUID()}.${imageExtensionFor(inline.mimeType)}`,
        );
        await fsPromises.writeFile(
          filePath,
          Buffer.from(inline.data, 'base64'),
        );
        savedPaths.push(filePath);
      }

      if (savedPaths.length === 0) {
        const message = 'Image generation produced no writable image data.';
        return {
          llmContent: message,
          returnDisplay: 'No image generated.',
          error: { message, type: ToolErrorType.FILE_WRITE_FAILURE },
        };
      }

      const summary =
        `Generated ${savedPaths.length} image(s) with ${this.modelName}. ` +
        `Saved to: ${savedPaths.join(', ')}`;
      const noteSuffix = notes.length > 0 ? ` ${notes.join(' ')}` : '';

      return {
        llmContent: [{ text: `${summary}.${noteSuffix}` }, ...inlineParts],
        returnDisplay: `Generated image saved to ${savedPaths[0]}`,
        data: { imagePaths: savedPaths, model: this.modelName },
      };
    } catch (error: unknown) {
      if (isAbortError(error)) {
        const timedOut = abortSignal.aborted === false;
        const message = timedOut
          ? `Image generation timed out after ${GENERATE_IMAGE_TIMEOUT_MS}ms.`
          : 'Image generation was cancelled.';
        return {
          llmContent: message,
          returnDisplay: timedOut
            ? 'Image generation timed out.'
            : 'Cancelled.',
          error: { message, type: ToolErrorType.EXECUTION_FAILED },
        };
      }

      const message = `Image generation failed: ${getErrorMessage(error)}`;
      debugLogger.warn(message, error);
      return {
        llmContent: message,
        returnDisplay: 'Error generating image.',
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
 * Generates or edits images using Google's image generation models.
 *
 * The model name is taken from the constructor, never from user settings, so
 * the integrator can wire the `generate-image` model-config alias.
 */
export class GenerateImageTool extends BaseDeclarativeTool<
  GenerateImageParams,
  ToolResult
> {
  static readonly Name = 'generate_image';

  static readonly Description = GENERATE_IMAGE_DESCRIPTION;

  private readonly modelName: string;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
    modelName: string = DEFAULT_GENERATE_IMAGE_MODEL,
  ) {
    super(
      GenerateImageTool.Name,
      'Generate Image',
      GenerateImageTool.Description,
      Kind.Execute,
      GENERATE_IMAGE_PARAMETERS_JSON_SCHEMA,
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

  protected override validateToolParamValues(
    params: GenerateImageParams,
  ): string | null {
    if (!params.subject || params.subject.trim() === '') {
      return "The 'subject' parameter is required and cannot be empty.";
    }
    if (
      params.aspect_ratio !== undefined &&
      !isGenerateImageAspectRatio(params.aspect_ratio)
    ) {
      return `Invalid 'aspect_ratio': ${params.aspect_ratio}. Expected one of: ${Object.keys(ASPECT_RATIOS).join(', ')}.`;
    }
    if (
      params.image_size !== undefined &&
      !isGenerateImageSize(params.image_size)
    ) {
      return `Invalid 'image_size': ${params.image_size}. Expected one of: ${Object.keys(IMAGE_SIZES).join(', ')}.`;
    }
    if (params.changes?.some((change) => !change || change.trim() === '')) {
      return "Every entry in 'changes' must be a non-empty string.";
    }
    if (params.input?.some((entry) => !entry || !entry.path)) {
      return "Every entry in 'input' must provide a 'path'.";
    }
    return null;
  }

  protected createInvocation(
    params: GenerateImageParams,
    messageBus: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<GenerateImageParams, ToolResult> {
    return new GenerateImageToolInvocation(
      this.config,
      this.modelName,
      params,
      messageBus,
      toolName,
      toolDisplayName,
    );
  }
}
