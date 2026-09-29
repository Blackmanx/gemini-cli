/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookPlanner, HookEventContext } from './hookPlanner.js';
import type { HookRunner } from './hookRunner.js';
import type { HookAggregator, AggregatedHookResult } from './hookAggregator.js';
import {
  HookEventName,
  HookType,
  type HookConfig,
  type HookInput,
  type BeforeToolInput,
  type AfterToolInput,
  type BeforeAgentInput,
  type NotificationInput,
  type AfterAgentInput,
  type SessionStartInput,
  type SessionEndInput,
  type PreCompressInput,
  type BeforeModelInput,
  type AfterModelInput,
  type BeforeToolSelectionInput,
  type NotificationType,
  type SessionStartSource,
  type SessionEndReason,
  type PreCompressTrigger,
  type HookExecutionResult,
  type McpToolContext,
  type TurnStartInput,
  type TurnEndInput,
  type AutoCompactionStartInput,
  type AutoCompactionEndInput,
  type AutoRetryStartInput,
  type AutoRetryEndInput,
  type BeforeSubagentSpawnInput,
} from './types.js';
import { defaultHookTranslator } from './hookTranslator.js';
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import { logHookCall } from '../telemetry/loggers.js';
import { HookCallEvent } from '../telemetry/types.js';
import { debugLogger } from '../utils/debugLogger.js';
import { coreEvents } from '../utils/events.js';
import type { Config } from '../config/config.js';
import type { GeminiClient } from '../core/client.js';

/**
 * What a hook invocation actually reads off the surrounding turn.
 *
 * Deliberately NOT {@link AgentLoopContext}: this handler never sees a full
 * agent loop, and claiming that type hid a real defect. `HookSystem` passes a
 * `Config`, so `context.config` was `undefined` at runtime and every emission
 * threw on `getSessionId()`. Observational events swallowed it and silently
 * stopped working; `before_subagent_spawn` turned it into a refusal of every
 * spawn, for a reason that had nothing to do with any hook's opinion.
 *
 * Naming the real dependency is what makes the mismatch impossible to write
 * again.
 */
export interface HookContext {
  /** The global runtime configuration. */
  readonly config: Config;
  /**
   * The client, if one exists yet. Optional because hooks can fire before the
   * client is constructed - a transcript path is a nicety, not a reason to
   * drop an event.
   */
  readonly geminiClient?: GeminiClient;
}

/**
 * The event-specific half of a hook input, minus the session fields
 * `createBaseInput` supplies. Splitting it this way keeps an emission site
 * from restating `session_id`, `cwd`, and `transcript_path` — values it has
 * no business knowing, and would only get wrong.
 */
export type TurnStartDetails = Omit<TurnStartInput, keyof HookInput>;
export type TurnEndDetails = Omit<TurnEndInput, keyof HookInput>;
export type AutoCompactionStartDetails = Omit<
  AutoCompactionStartInput,
  keyof HookInput
>;
export type AutoCompactionEndDetails = Omit<
  AutoCompactionEndInput,
  keyof HookInput
>;
export type AutoRetryStartDetails = Omit<AutoRetryStartInput, keyof HookInput>;
export type AutoRetryEndDetails = Omit<AutoRetryEndInput, keyof HookInput>;
export type BeforeSubagentSpawnDetails = Omit<
  BeforeSubagentSpawnInput,
  keyof HookInput
>;

/**
 * Hook event bus that coordinates hook execution across the system
 */
export class HookEventHandler {
  private readonly context: HookContext;
  private readonly hookPlanner: HookPlanner;
  private readonly hookRunner: HookRunner;
  private readonly hookAggregator: HookAggregator;

  /**
   * Track reported failures to suppress duplicate warnings during streaming.
   * Uses a WeakMap with the original request object as a key to ensure
   * failures are only reported once per logical model interaction.
   */
  private readonly reportedFailures = new WeakMap<object, Set<string>>();

  constructor(
    context: HookContext,
    hookPlanner: HookPlanner,
    hookRunner: HookRunner,
    hookAggregator: HookAggregator,
  ) {
    this.context = context;
    this.hookPlanner = hookPlanner;
    this.hookRunner = hookRunner;
    this.hookAggregator = hookAggregator;
  }

  /**
   * Fire a BeforeTool event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async fireBeforeToolEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    mcpContext?: McpToolContext,
    originalRequestName?: string,
  ): Promise<AggregatedHookResult> {
    const input: BeforeToolInput = {
      ...this.createBaseInput(HookEventName.BeforeTool),
      tool_name: toolName,
      tool_input: toolInput,
      ...(mcpContext && { mcp_context: mcpContext }),
      ...(originalRequestName && {
        original_request_name: originalRequestName,
      }),
    };

    const context: HookEventContext = { toolName };
    return this.executeHooks(HookEventName.BeforeTool, input, context);
  }

  /**
   * Fire an AfterTool event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async fireAfterToolEvent(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown>,
    mcpContext?: McpToolContext,
    originalRequestName?: string,
  ): Promise<AggregatedHookResult> {
    const input: AfterToolInput = {
      ...this.createBaseInput(HookEventName.AfterTool),
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      ...(mcpContext && { mcp_context: mcpContext }),
      ...(originalRequestName && {
        original_request_name: originalRequestName,
      }),
    };

    const context: HookEventContext = { toolName };
    return this.executeHooks(HookEventName.AfterTool, input, context);
  }

  /**
   * Fire a BeforeAgent event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async fireBeforeAgentEvent(prompt: string): Promise<AggregatedHookResult> {
    const input: BeforeAgentInput = {
      ...this.createBaseInput(HookEventName.BeforeAgent),
      prompt,
    };

    return this.executeHooks(HookEventName.BeforeAgent, input);
  }

  /**
   * Fire a Notification event
   */
  async fireNotificationEvent(
    type: NotificationType,
    message: string,
    details: Record<string, unknown>,
  ): Promise<AggregatedHookResult> {
    const input: NotificationInput = {
      ...this.createBaseInput(HookEventName.Notification),
      notification_type: type,
      message,
      details,
    };

    return this.executeHooks(HookEventName.Notification, input);
  }

  /**
   * Fire an AfterAgent event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async fireAfterAgentEvent(
    prompt: string,
    promptResponse: string,
    stopHookActive: boolean = false,
  ): Promise<AggregatedHookResult> {
    const input: AfterAgentInput = {
      ...this.createBaseInput(HookEventName.AfterAgent),
      prompt,
      prompt_response: promptResponse,
      stop_hook_active: stopHookActive,
    };

    return this.executeHooks(HookEventName.AfterAgent, input);
  }

  /**
   * Fire a SessionStart event
   */
  async fireSessionStartEvent(
    source: SessionStartSource,
  ): Promise<AggregatedHookResult> {
    const input: SessionStartInput = {
      ...this.createBaseInput(HookEventName.SessionStart),
      source,
    };

    const context: HookEventContext = { trigger: source };
    return this.executeHooks(HookEventName.SessionStart, input, context);
  }

  /**
   * Fire a SessionEnd event
   */
  async fireSessionEndEvent(
    reason: SessionEndReason,
  ): Promise<AggregatedHookResult> {
    const input: SessionEndInput = {
      ...this.createBaseInput(HookEventName.SessionEnd),
      reason,
    };

    const context: HookEventContext = { trigger: reason };
    return this.executeHooks(HookEventName.SessionEnd, input, context);
  }

  /**
   * Fire a PreCompress event
   */
  async firePreCompressEvent(
    trigger: PreCompressTrigger,
  ): Promise<AggregatedHookResult> {
    const input: PreCompressInput = {
      ...this.createBaseInput(HookEventName.PreCompress),
      trigger,
    };

    const context: HookEventContext = { trigger };
    return this.executeHooks(HookEventName.PreCompress, input, context);
  }

  /**
   * Fire a BeforeModel event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async fireBeforeModelEvent(
    llmRequest: GenerateContentParameters,
  ): Promise<AggregatedHookResult> {
    const input: BeforeModelInput = {
      ...this.createBaseInput(HookEventName.BeforeModel),
      llm_request: defaultHookTranslator.toHookLLMRequest(llmRequest),
    };

    return this.executeHooks(
      HookEventName.BeforeModel,
      input,
      undefined,
      llmRequest,
    );
  }

  /**
   * Fire an AfterModel event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async fireAfterModelEvent(
    llmRequest: GenerateContentParameters,
    llmResponse: GenerateContentResponse,
  ): Promise<AggregatedHookResult> {
    const input: AfterModelInput = {
      ...this.createBaseInput(HookEventName.AfterModel),
      llm_request: defaultHookTranslator.toHookLLMRequest(llmRequest),
      llm_response: defaultHookTranslator.toHookLLMResponse(llmResponse),
    };

    return this.executeHooks(
      HookEventName.AfterModel,
      input,
      undefined,
      llmRequest,
    );
  }

  /**
   * Fire a BeforeToolSelection event
   * Called by handleHookExecutionRequest - executes hooks directly
   */
  async fireBeforeToolSelectionEvent(
    llmRequest: GenerateContentParameters,
  ): Promise<AggregatedHookResult> {
    const input: BeforeToolSelectionInput = {
      ...this.createBaseInput(HookEventName.BeforeToolSelection),
      llm_request: defaultHookTranslator.toHookLLMRequest(llmRequest),
    };

    return this.executeHooks(
      HookEventName.BeforeToolSelection,
      input,
      undefined,
      llmRequest,
    );
  }

  /**
   * Fire a TurnStart event - a model turn is about to be dispatched
   */
  async fireTurnStartEvent(
    details: TurnStartDetails,
  ): Promise<AggregatedHookResult> {
    const input: TurnStartInput = {
      ...this.createBaseInput(HookEventName.TurnStart),
      ...details,
    };

    return this.executeHooks(HookEventName.TurnStart, input);
  }

  /**
   * Fire a TurnEnd event - the turn dispatched at the paired TurnStart settled
   */
  async fireTurnEndEvent(
    details: TurnEndDetails,
  ): Promise<AggregatedHookResult> {
    const input: TurnEndInput = {
      ...this.createBaseInput(HookEventName.TurnEnd),
      ...details,
    };

    return this.executeHooks(HookEventName.TurnEnd, input);
  }

  /**
   * Fire an AutoCompactionStart event
   */
  async fireAutoCompactionStartEvent(
    details: AutoCompactionStartDetails,
  ): Promise<AggregatedHookResult> {
    const input: AutoCompactionStartInput = {
      ...this.createBaseInput(HookEventName.AutoCompactionStart),
      ...details,
    };

    return this.executeHooks(HookEventName.AutoCompactionStart, input);
  }

  /**
   * Fire an AutoCompactionEnd event, carrying the outcome PreCompress cannot
   */
  async fireAutoCompactionEndEvent(
    details: AutoCompactionEndDetails,
  ): Promise<AggregatedHookResult> {
    const input: AutoCompactionEndInput = {
      ...this.createBaseInput(HookEventName.AutoCompactionEnd),
      ...details,
    };

    return this.executeHooks(HookEventName.AutoCompactionEnd, input);
  }

  /**
   * Fire an AutoRetryStart event
   */
  async fireAutoRetryStartEvent(
    details: AutoRetryStartDetails,
  ): Promise<AggregatedHookResult> {
    const input: AutoRetryStartInput = {
      ...this.createBaseInput(HookEventName.AutoRetryStart),
      ...details,
    };

    return this.executeHooks(HookEventName.AutoRetryStart, input);
  }

  /**
   * Fire an AutoRetryEnd event
   */
  async fireAutoRetryEndEvent(
    details: AutoRetryEndDetails,
  ): Promise<AggregatedHookResult> {
    const input: AutoRetryEndInput = {
      ...this.createBaseInput(HookEventName.AutoRetryEnd),
      ...details,
    };

    return this.executeHooks(HookEventName.AutoRetryEnd, input);
  }

  /**
   * Fire a BeforeSubagentSpawn event
   *
   * `agentName` doubles as the matcher context, so a hook can be scoped to one
   * subagent (`"matcher": "codebase-investigator"`) rather than to every
   * delegation the session makes.
   */
  async fireBeforeSubagentSpawnEvent(
    details: BeforeSubagentSpawnDetails,
  ): Promise<AggregatedHookResult> {
    const input: BeforeSubagentSpawnInput = {
      ...this.createBaseInput(HookEventName.BeforeSubagentSpawn),
      ...details,
    };

    const context: HookEventContext = { toolName: details.agent_name };
    return this.executeHooks(HookEventName.BeforeSubagentSpawn, input, context);
  }

  /**
   * Execute hooks for a specific event (direct execution without MessageBus)
   * Used as fallback when MessageBus is not available
   */
  private async executeHooks(
    eventName: HookEventName,
    input: HookInput,
    context?: HookEventContext,
    requestContext?: object,
  ): Promise<AggregatedHookResult> {
    try {
      // Create execution plan
      const plan = this.hookPlanner.createExecutionPlan(eventName, context);

      if (!plan || plan.hookConfigs.length === 0) {
        return {
          success: true,
          allOutputs: [],
          errors: [],
          totalDuration: 0,
        };
      }

      const onHookStart = (config: HookConfig, index: number) => {
        coreEvents.emitHookStart({
          hookName: this.getHookName(config),
          eventName,
          source: config.source,
          hookIndex: index + 1,
          totalHooks: plan.hookConfigs.length,
        });
      };

      const onHookEnd = (config: HookConfig, result: HookExecutionResult) => {
        coreEvents.emitHookEnd({
          hookName: this.getHookName(config),
          eventName,
          success: result.success,
        });
      };

      // Execute hooks according to the plan's strategy
      const results = plan.sequential
        ? await this.hookRunner.executeHooksSequential(
            plan.hookConfigs,
            eventName,
            input,
            onHookStart,
            onHookEnd,
          )
        : await this.hookRunner.executeHooksParallel(
            plan.hookConfigs,
            eventName,
            input,
            onHookStart,
            onHookEnd,
          );

      // Aggregate results
      const aggregated = this.hookAggregator.aggregateResults(
        results,
        eventName,
      );

      // Process common hook output fields centrally
      this.processCommonHookOutputFields(aggregated);

      // Log hook execution
      this.logHookExecution(
        eventName,
        input,
        results,
        aggregated,
        requestContext,
      );

      return aggregated;
    } catch (error) {
      debugLogger.error(`Hook event bus error for ${eventName}: ${error}`);

      return {
        success: false,
        allOutputs: [],
        errors: [error instanceof Error ? error : new Error(String(error))],
        totalDuration: 0,
      };
    }
  }

  /**
   * Create base hook input with common fields
   */
  private createBaseInput(eventName: HookEventName): HookInput {
    // Get the transcript path from the ChatRecordingService if available
    const transcriptPath =
      this.context.geminiClient
        ?.getChatRecordingService()
        ?.getConversationFilePath() ?? '';

    return {
      session_id: this.context.config.getSessionId(),
      transcript_path: transcriptPath,
      cwd: this.context.config.getWorkingDir(),
      hook_event_name: eventName,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Log hook execution for observability
   */
  private logHookExecution(
    eventName: HookEventName,
    input: HookInput,
    results: HookExecutionResult[],
    aggregated: AggregatedHookResult,
    requestContext?: object,
  ): void {
    const failedHooks = results.filter((r) => !r.success);
    const successCount = results.length - failedHooks.length;
    const errorCount = failedHooks.length;

    if (errorCount > 0) {
      const failedNames = failedHooks
        .map((r) => this.getHookNameFromResult(r))
        .join(', ');

      let shouldEmit = true;
      if (requestContext) {
        let reportedSet = this.reportedFailures.get(requestContext);
        if (!reportedSet) {
          reportedSet = new Set<string>();
          this.reportedFailures.set(requestContext, reportedSet);
        }

        const failureKey = `${eventName}:${failedNames}`;
        if (reportedSet.has(failureKey)) {
          shouldEmit = false;
        } else {
          reportedSet.add(failureKey);
        }
      }

      debugLogger.warn(
        `Hook execution for ${eventName}: ${successCount} succeeded, ${errorCount} failed (${failedNames}), ` +
          `total duration: ${aggregated.totalDuration}ms`,
      );

      if (shouldEmit) {
        coreEvents.emitFeedback(
          'warning',
          `Hook(s) [${failedNames}] failed for event ${eventName}. Press F12 to see the debug drawer for more details.\n`,
        );
      }
    } else {
      debugLogger.debug(
        `Hook execution for ${eventName}: ${successCount} hooks executed successfully, ` +
          `total duration: ${aggregated.totalDuration}ms`,
      );
    }

    // Log individual hook calls to telemetry
    for (const result of results) {
      // Determine hook name and type for telemetry
      const hookName = this.getHookNameFromResult(result);
      const hookType = this.getHookTypeFromResult(result);

      const hookCallEvent = new HookCallEvent(
        eventName,
        hookType,
        hookName,
        { ...input },
        result.duration,
        result.success,
        result.output ? { ...result.output } : undefined,
        result.exitCode,
        result.stdout,
        result.stderr,
        result.error?.message,
      );

      logHookCall(this.context.config, hookCallEvent);

      // Emit structured system message event for UI display. Covers both
      // 'json' and 'text' output formats so plain-text hook stdout also surfaces.
      if (result.output?.systemMessage) {
        coreEvents.emitHookSystemMessage({
          hookName,
          eventName,
          message: result.output.systemMessage,
        });
      }
    }

    // Log individual errors
    for (const error of aggregated.errors) {
      debugLogger.warn(`Hook execution error: ${error.message}`);
    }
  }

  /**
   * Process common hook output fields centrally
   */
  private processCommonHookOutputFields(
    aggregated: AggregatedHookResult,
  ): void {
    if (!aggregated.finalOutput) {
      return;
    }

    // Handle systemMessage - show to user in transcript mode (not to agent)
    const systemMessage = aggregated.finalOutput.systemMessage;
    if (systemMessage && !aggregated.finalOutput.suppressOutput) {
      debugLogger.warn(`Hook system message: ${systemMessage}`);
    }

    // Handle suppressOutput - already handled by not logging above when true

    // Handle continue=false - this should stop the entire agent execution
    if (aggregated.finalOutput.shouldStopExecution()) {
      const stopReason = aggregated.finalOutput.getEffectiveReason();
      debugLogger.log(`Hook requested to stop execution: ${stopReason}`);

      // Note: The actual stopping of execution must be handled by integration points
      // as they need to interpret this signal in the context of their specific workflow
      // This is just logging the request centrally
    }

    // Other common fields like decision/reason are handled by specific hook output classes
  }

  /**
   * Get hook name from config for display or telemetry
   */
  private getHookName(config: HookConfig): string {
    if (config.type === HookType.Command) {
      return config.name || config.command || 'unknown-command';
    }
    return config.name || 'unknown-hook';
  }

  /**
   * Get hook name from execution result for telemetry
   */
  private getHookNameFromResult(result: HookExecutionResult): string {
    return this.getHookName(result.hookConfig);
  }

  /**
   * Get hook type from execution result for telemetry
   */
  private getHookTypeFromResult(result: HookExecutionResult): HookType {
    return result.hookConfig.type;
  }
}
