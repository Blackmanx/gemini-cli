/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { HookRegistry, type HookRegistryEntry } from './hookRegistry.js';
import { HookRunner } from './hookRunner.js';
import { HookAggregator, type AggregatedHookResult } from './hookAggregator.js';
import { HookPlanner } from './hookPlanner.js';
import {
  HookEventHandler,
  type TurnStartDetails,
  type TurnEndDetails,
  type AutoCompactionStartDetails,
  type AutoCompactionEndDetails,
  type AutoRetryStartDetails,
  type AutoRetryEndDetails,
  type BeforeSubagentSpawnDetails,
} from './hookEventHandler.js';
import { debugLogger } from '../utils/debugLogger.js';
import {
  NotificationType,
  type SessionStartSource,
  type SessionEndReason,
  type PreCompressTrigger,
  type DefaultHookOutput,
  type BeforeModelHookOutput,
  type AfterModelHookOutput,
  type BeforeToolSelectionHookOutput,
  type McpToolContext,
  type HookConfig,
  type HookEventName,
  type ConfigSource,
} from './types.js';
import type {
  GenerateContentParameters,
  GenerateContentResponse,
  GenerateContentConfig,
  ContentListUnion,
  ToolConfig,
  ToolListUnion,
} from '@google/genai';
import type { ToolCallConfirmationDetails } from '../tools/tools.js';

/**
 * Main hook system that coordinates all hook-related functionality
 */

export interface BeforeModelHookResult {
  /** Whether the model call was blocked */
  blocked: boolean;
  /** Whether the execution should be stopped entirely */
  stopped?: boolean;
  /** Reason for blocking (if blocked) */
  reason?: string;
  /** Synthetic response to return instead of calling the model (if blocked) */
  syntheticResponse?: GenerateContentResponse;
  /** Modified model override (if not blocked) */
  modifiedModel?: string;
  /** Modified config (if not blocked) */
  modifiedConfig?: GenerateContentConfig;
  /** Modified contents (if not blocked) */
  modifiedContents?: ContentListUnion;
}

/**
 * Result from firing the BeforeToolSelection hook.
 */
export interface BeforeToolSelectionHookResult {
  /** Modified tool config */
  toolConfig?: ToolConfig;
  /** Modified tools */
  tools?: ToolListUnion;
}

/**
 * Result from firing the AfterModel hook.
 * Contains either a modified response or indicates to use the original chunk.
 */
export interface AfterModelHookResult {
  /** The response to yield (either modified or original) */
  response: GenerateContentResponse;
  /** Whether the execution should be stopped entirely */
  stopped?: boolean;
  /** Whether the model call was blocked */
  blocked?: boolean;
  /** Reason for blocking or stopping */
  reason?: string;
}

/**
 * Converts ToolCallConfirmationDetails to a serializable format for hooks.
 * Excludes function properties (onConfirm, ideConfirmation) that can't be serialized.
 */
function toSerializableDetails(
  details: ToolCallConfirmationDetails,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type: details.type,
    title: details.title,
  };

  switch (details.type) {
    case 'edit':
      return {
        ...base,
        fileName: details.fileName,
        filePath: details.filePath,
        fileDiff: details.fileDiff,
        originalContent: details.originalContent,
        newContent: details.newContent,
        isModifying: details.isModifying,
      };
    case 'exec':
      return {
        ...base,
        command: details.command,
        rootCommand: details.rootCommand,
      };
    case 'mcp':
      return {
        ...base,
        serverName: details.serverName,
        toolName: details.toolName,
        toolDisplayName: details.toolDisplayName,
      };
    case 'info':
      return {
        ...base,
        prompt: details.prompt,
        urls: details.urls,
      };
    default:
      return base;
  }
}

/**
 * Gets the message to display in the notification hook for tool confirmation.
 */
function getNotificationMessage(
  confirmationDetails: ToolCallConfirmationDetails,
): string {
  switch (confirmationDetails.type) {
    case 'edit':
      return `Tool ${confirmationDetails.title} requires editing`;
    case 'exec':
      return `Tool ${confirmationDetails.title} requires execution`;
    case 'mcp':
      return `Tool ${confirmationDetails.title} requires MCP`;
    case 'info':
      return `Tool ${confirmationDetails.title} requires information`;
    default:
      return `Tool requires confirmation`;
  }
}

/**
 * The answer to "may this subagent delegation proceed?".
 *
 * A decision rather than a boolean because the refusal has to reach the model
 * as prose: a spawn that silently does not happen looks identical to a
 * subagent that produced nothing, and the model will retry the same call
 * forever.
 */
export interface SubagentSpawnDecision {
  cancelled: boolean;
  /** Why the delegation was refused. Absent when it was allowed. */
  reason?: string;
  /** Message for the user, distinct from what the model is told. */
  systemMessage?: string;
}

export class HookSystem {
  private readonly hookRegistry: HookRegistry;
  private readonly hookRunner: HookRunner;
  private readonly hookAggregator: HookAggregator;
  private readonly hookPlanner: HookPlanner;
  private readonly hookEventHandler: HookEventHandler;

  constructor(config: Config) {
    // Initialize components
    this.hookRegistry = new HookRegistry(config);
    this.hookRunner = new HookRunner(config);
    this.hookAggregator = new HookAggregator();
    this.hookPlanner = new HookPlanner(this.hookRegistry);
    this.hookEventHandler = new HookEventHandler(
      config,
      this.hookPlanner,
      this.hookRunner,
      this.hookAggregator,
    );
  }

  /**
   * Initialize the hook system
   */
  async initialize(): Promise<void> {
    await this.hookRegistry.initialize();
    debugLogger.debug('Hook system initialized successfully');
  }

  /**
   * Get the hook event bus for firing events
   */
  getEventHandler(): HookEventHandler {
    return this.hookEventHandler;
  }

  /**
   * Get hook registry for management operations
   */
  getRegistry(): HookRegistry {
    return this.hookRegistry;
  }

  /**
   * Enable or disable a hook
   */
  setHookEnabled(hookName: string, enabled: boolean): void {
    this.hookRegistry.setHookEnabled(hookName, enabled);
  }

  /**
   * Get all registered hooks for display/management
   */
  getAllHooks(): HookRegistryEntry[] {
    return this.hookRegistry.getAllHooks();
  }

  /**
   * Register a new hook programmatically
   */
  registerHook(
    config: HookConfig,
    eventName: HookEventName,
    options?: { matcher?: string; sequential?: boolean; source?: ConfigSource },
  ): void {
    this.hookRegistry.registerHook(config, eventName, options);
  }

  /**
   * Fire hook events directly
   */
  async fireSessionStartEvent(
    source: SessionStartSource,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireSessionStartEvent(source);
    return result.finalOutput;
  }

  async fireSessionEndEvent(
    reason: SessionEndReason,
  ): Promise<AggregatedHookResult | undefined> {
    return this.hookEventHandler.fireSessionEndEvent(reason);
  }

  async firePreCompressEvent(
    trigger: PreCompressTrigger,
  ): Promise<AggregatedHookResult | undefined> {
    return this.hookEventHandler.firePreCompressEvent(trigger);
  }

  async fireBeforeAgentEvent(
    prompt: string,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireBeforeAgentEvent(prompt);
    return result.finalOutput;
  }

  async fireAfterAgentEvent(
    prompt: string,
    response: string,
    stopHookActive: boolean = false,
  ): Promise<DefaultHookOutput | undefined> {
    const result = await this.hookEventHandler.fireAfterAgentEvent(
      prompt,
      response,
      stopHookActive,
    );
    return result.finalOutput;
  }

  async fireBeforeModelEvent(
    llmRequest: GenerateContentParameters,
  ): Promise<BeforeModelHookResult> {
    try {
      const result =
        await this.hookEventHandler.fireBeforeModelEvent(llmRequest);
      const hookOutput = result.finalOutput;

      if (hookOutput?.shouldStopExecution()) {
        return {
          blocked: true,
          stopped: true,
          reason: hookOutput.getEffectiveReason(),
        };
      }

      const blockingError = hookOutput?.getBlockingError();
      if (blockingError?.blocked) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const beforeModelOutput = hookOutput as BeforeModelHookOutput;
        const syntheticResponse = beforeModelOutput.getSyntheticResponse();
        return {
          blocked: true,
          reason:
            hookOutput?.getEffectiveReason() || 'Model call blocked by hook',
          syntheticResponse,
        };
      }

      if (hookOutput) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const beforeModelOutput = hookOutput as BeforeModelHookOutput;
        const modifiedRequest =
          beforeModelOutput.applyLLMRequestModifications(llmRequest);
        return {
          blocked: false,
          modifiedModel: modifiedRequest?.model,
          modifiedConfig: modifiedRequest?.config,
          modifiedContents: modifiedRequest?.contents,
        };
      }

      return { blocked: false };
    } catch (error) {
      debugLogger.debug(`BeforeModelHookEvent failed:`, error);
      return { blocked: false };
    }
  }

  async fireAfterModelEvent(
    originalRequest: GenerateContentParameters,
    chunk: GenerateContentResponse,
  ): Promise<AfterModelHookResult> {
    try {
      const result = await this.hookEventHandler.fireAfterModelEvent(
        originalRequest,
        chunk,
      );
      const hookOutput = result.finalOutput;

      if (hookOutput?.shouldStopExecution()) {
        return {
          response: chunk,
          stopped: true,
          reason: hookOutput.getEffectiveReason(),
        };
      }

      const blockingError = hookOutput?.getBlockingError();
      if (blockingError?.blocked) {
        return {
          response: chunk,
          blocked: true,
          reason: hookOutput?.getEffectiveReason(),
        };
      }

      if (hookOutput) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const afterModelOutput = hookOutput as AfterModelHookOutput;
        const modifiedResponse = afterModelOutput.getModifiedResponse();
        if (modifiedResponse) {
          return { response: modifiedResponse };
        }
      }

      return { response: chunk };
    } catch (error) {
      debugLogger.debug(`AfterModelHookEvent failed:`, error);
      return { response: chunk };
    }
  }

  async fireBeforeToolSelectionEvent(
    llmRequest: GenerateContentParameters,
  ): Promise<BeforeToolSelectionHookResult> {
    try {
      const result =
        await this.hookEventHandler.fireBeforeToolSelectionEvent(llmRequest);
      const hookOutput = result.finalOutput;

      if (hookOutput) {
        const toolSelectionOutput = hookOutput as BeforeToolSelectionHookOutput;
        const modifiedConfig = toolSelectionOutput.applyToolConfigModifications(
          {
            toolConfig: llmRequest.config?.toolConfig,
            tools: llmRequest.config?.tools,
          },
        );
        return {
          toolConfig: modifiedConfig.toolConfig,
          tools: modifiedConfig.tools,
        };
      }
      return {};
    } catch (error) {
      debugLogger.debug(`BeforeToolSelectionEvent failed:`, error);
      return {};
    }
  }

  async fireBeforeToolEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    mcpContext?: McpToolContext,
    originalRequestName?: string,
  ): Promise<DefaultHookOutput | undefined> {
    try {
      const result = await this.hookEventHandler.fireBeforeToolEvent(
        toolName,
        toolInput,
        mcpContext,
        originalRequestName,
      );
      return result.finalOutput;
    } catch (error) {
      debugLogger.debug(`BeforeToolEvent failed for ${toolName}:`, error);
      return undefined;
    }
  }

  async fireAfterToolEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: {
      llmContent: unknown;
      returnDisplay: unknown;
      error: unknown;
    },
    mcpContext?: McpToolContext,
    originalRequestName?: string,
  ): Promise<DefaultHookOutput | undefined> {
    try {
      const result = await this.hookEventHandler.fireAfterToolEvent(
        toolName,
        toolInput,
        toolResponse as Record<string, unknown>,
        mcpContext,
        originalRequestName,
      );
      return result.finalOutput;
    } catch (error) {
      debugLogger.debug(`AfterToolEvent failed for ${toolName}:`, error);
      return undefined;
    }
  }

  async fireToolNotificationEvent(
    confirmationDetails: ToolCallConfirmationDetails,
  ): Promise<void> {
    try {
      const message = getNotificationMessage(confirmationDetails);
      const serializedDetails = toSerializableDetails(confirmationDetails);

      await this.hookEventHandler.fireNotificationEvent(
        NotificationType.ToolPermission,
        message,
        serializedDetails,
      );
    } catch (error) {
      debugLogger.debug(
        `NotificationEvent failed for ${confirmationDetails.title}:`,
        error,
      );
    }
  }

  /**
   * Notify hooks that a model turn is about to be dispatched.
   *
   * Fire-and-forget by design: a hook cannot veto the turn from here (the
   * request is already committed by the time this is reached) and a hook that
   * fails here must not take the turn down with it.
   */
  async fireTurnStartEvent(details: TurnStartDetails): Promise<void> {
    await this.notifyBestEffort(
      () => this.hookEventHandler.fireTurnStartEvent(details),
      'TurnStart',
    );
  }

  /**
   * Notify hooks that the turn dispatched at the paired TurnStart settled.
   */
  async fireTurnEndEvent(details: TurnEndDetails): Promise<void> {
    await this.notifyBestEffort(
      () => this.hookEventHandler.fireTurnEndEvent(details),
      'TurnEnd',
    );
  }

  /**
   * Notify hooks that automatic compaction is about to run.
   */
  async fireAutoCompactionStartEvent(
    details: AutoCompactionStartDetails,
  ): Promise<void> {
    await this.notifyBestEffort(
      () => this.hookEventHandler.fireAutoCompactionStartEvent(details),
      'AutoCompactionStart',
    );
  }

  /**
   * Notify hooks of the outcome of an automatic compaction.
   */
  async fireAutoCompactionEndEvent(
    details: AutoCompactionEndDetails,
  ): Promise<void> {
    await this.notifyBestEffort(
      () => this.hookEventHandler.fireAutoCompactionEndEvent(details),
      'AutoCompactionEnd',
    );
  }

  /**
   * Notify hooks that a model call is backing off before a retry.
   */
  async fireAutoRetryStartEvent(details: AutoRetryStartDetails): Promise<void> {
    await this.notifyBestEffort(
      () => this.hookEventHandler.fireAutoRetryStartEvent(details),
      'AutoRetryStart',
    );
  }

  /**
   * Notify hooks that a retry saga settled.
   */
  async fireAutoRetryEndEvent(details: AutoRetryEndDetails): Promise<void> {
    await this.notifyBestEffort(
      () => this.hookEventHandler.fireAutoRetryEndEvent(details),
      'AutoRetryEnd',
    );
  }

  /**
   * Ask hooks whether a subagent delegation may proceed.
   *
   * Fail-closed, and it is the emission site's call to make: a hook that
   * throws, exits non-zero, or asks to cancel all produce the same answer —
   * do not spawn. A guard that lets work through because the guard itself
   * broke is not a guard.
   */
  async fireBeforeSubagentSpawnEvent(
    details: BeforeSubagentSpawnDetails,
  ): Promise<SubagentSpawnDecision> {
    try {
      const result =
        await this.hookEventHandler.fireBeforeSubagentSpawnEvent(details);
      const output = result.finalOutput;
      const refusedByHook =
        output?.cancel === true || output?.isBlockingDecision();
      if (!result.success || refusedByHook) {
        const reason = result.success
          ? output?.getEffectiveReason()
          : (result.errors[0]?.message ?? 'a BeforeSubagentSpawn hook failed');
        return {
          cancelled: true,
          reason: reason ?? 'Subagent spawn cancelled by a hook',
          systemMessage: output?.systemMessage,
        };
      }
      return { cancelled: false };
    } catch (error) {
      return {
        cancelled: true,
        reason:
          error instanceof Error
            ? error.message
            : 'BeforeSubagentSpawn hook failed',
      };
    }
  }

  /**
   * Run a notification hook, swallowing its failure.
   *
   * Every non-cancellable event routes through here. A hook that breaks while
   * merely observing something must not be able to break the thing it is
   * observing — the caller has already decided to do the work.
   */
  private async notifyBestEffort(
    fire: () => Promise<AggregatedHookResult>,
    eventName: string,
  ): Promise<void> {
    try {
      await fire();
    } catch (error) {
      debugLogger.debug(`${eventName} hooks failed:`, error);
    }
  }
}
