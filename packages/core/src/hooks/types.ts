/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GenerateContentResponse,
  GenerateContentParameters,
  ToolConfig as GenAIToolConfig,
  ToolListUnion,
} from '@google/genai';
import {
  defaultHookTranslator,
  type LLMRequest,
  type LLMResponse,
  type HookToolConfig,
} from './hookTranslator.js';

/**
 * Configuration source levels in precedence order (highest to lowest)
 */
export enum ConfigSource {
  Runtime = 'runtime',
  Project = 'project',
  User = 'user',
  System = 'system',
  Extensions = 'extensions',
}

/**
 * Returns true if a hook source implies it is a user-visible hook.
 * Only System hooks are hidden by default to reduce noise.
 */
export function isUserVisibleHook(source?: string | ConfigSource): boolean {
  if (!source) return true; // Treat unknown/legacy hooks as user-visible
  return source !== ConfigSource.System;
}

/**
 * Event names for the hook system
 */
export enum HookEventName {
  BeforeTool = 'BeforeTool',
  AfterTool = 'AfterTool',
  BeforeAgent = 'BeforeAgent',
  Notification = 'Notification',
  AfterAgent = 'AfterAgent',
  SessionStart = 'SessionStart',
  SessionEnd = 'SessionEnd',
  PreCompress = 'PreCompress',
  BeforeModel = 'BeforeModel',
  AfterModel = 'AfterModel',
  BeforeToolSelection = 'BeforeToolSelection',
  /**
   * A model turn is about to be dispatched. Fires once per model call in the
   * agent loop, paired 1:1 with {@link HookEventName.TurnEnd}.
   */
  TurnStart = 'TurnStart',
  /**
   * The model turn dispatched at the matching {@link HookEventName.TurnStart}
   * has finished, successfully or not.
   */
  TurnEnd = 'TurnEnd',
  /**
   * Automatic context compaction is about to run. Unlike the read-only
   * {@link HookEventName.PreCompress}, this pair reports the outcome: the
   * matching {@link HookEventName.AutoCompactionEnd} carries the resulting
   * compression status and token counts.
   */
  AutoCompactionStart = 'AutoCompactionStart',
  /**
   * The automatic compaction started at the matching
   * {@link HookEventName.AutoCompactionStart} has settled, successfully or not.
   */
  AutoCompactionEnd = 'AutoCompactionEnd',
  /**
   * The transport gave up on an attempt and is backing off before retrying.
   * Fires at most once per model call, on the first retry.
   */
  AutoRetryStart = 'AutoRetryStart',
  /**
   * The retry saga started at the matching {@link HookEventName.AutoRetryStart}
   * has settled, either recovered or exhausted.
   */
  AutoRetryEnd = 'AutoRetryEnd',
  /**
   * A subagent delegation is about to be dispatched. Cancellable: see
   * {@link BeforeSubagentSpawnOutput}.
   */
  BeforeSubagentSpawn = 'BeforeSubagentSpawn',
}

/**
 * Fields in the hooks configuration that are not hook event names
 */
export const HOOKS_CONFIG_FIELDS = ['enabled', 'disabled', 'notifications'];

/**
 * Hook implementation types
 */
export enum HookType {
  Command = 'command',
  Runtime = 'runtime',
}

/**
 * Hook action function
 */
export type HookAction = (
  input: HookInput,
  options?: { signal: AbortSignal },
) => Promise<HookOutput | void | null>;

/**
 * Runtime hook configuration
 */
export interface RuntimeHookConfig {
  type: HookType.Runtime;
  /** Unique name for the runtime hook */
  name: string;
  /** Function to execute when the hook is triggered */
  action: HookAction;
  command?: never;
  source?: ConfigSource;
  /** Maximum time allowed for hook execution in milliseconds */
  timeout?: number;
}

/**
 * Command hook configuration entry
 */
export interface CommandHookConfig {
  type: HookType.Command;
  command: string;
  action?: never;
  name?: string;
  description?: string;
  timeout?: number;
  source?: ConfigSource;
  env?: Record<string, string>;
}

export type HookConfig = CommandHookConfig | RuntimeHookConfig;

/**
 * Hook definition with matcher
 */
export interface HookDefinition {
  matcher?: string;
  sequential?: boolean;
  hooks: HookConfig[];
}

/**
 * Generate a unique key for a hook configuration
 */
export function getHookKey(hook: HookConfig): string {
  const name = hook.name || '';
  const command = hook.type === HookType.Command ? hook.command : '';
  return `${name}:${command}`;
}

/**
 * Decision types for hook outputs
 */
export type HookDecision =
  | 'ask'
  | 'block'
  | 'deny'
  | 'approve'
  | 'allow'
  | undefined;

/**
 * Base hook input - common fields for all events
 */
export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  timestamp: string;
}

/**
 * Base hook output - common fields for all events
 */
export interface HookOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  decision?: HookDecision;
  reason?: string;
  /**
   * Veto the operation a `before_*` event is guarding.
   *
   * Only meaningful on the cancellable events (currently
   * {@link HookEventName.BeforeSubagentSpawn}); ignored elsewhere, so a hook
   * that always sets it is harmless on events that cannot be stopped.
   *
   * This is fail-closed, and deliberately so. A hook that crashes, times out,
   * or exits non-zero is treated as a refusal, not as an absent opinion: the
   * guard exists to stop work, and a guard that silently waves through
   * because it broke is worse than no guard at all. The counterpart of that
   * rule is that a hook which wants to *allow* the operation must say so
   * explicitly (`{"cancel": false}`) rather than by staying quiet.
   */
  cancel?: boolean;
  hookSpecificOutput?: Record<string, unknown>;
}

/**
 * Factory function to create the appropriate hook output class based on event name
 * Returns DefaultHookOutput for all events since it contains all necessary methods
 */
export function createHookOutput(
  eventName: string,
  data: Partial<HookOutput>,
): DefaultHookOutput {
  switch (eventName) {
    case 'BeforeModel':
      return new BeforeModelHookOutput(data);
    case 'AfterModel':
      return new AfterModelHookOutput(data);
    case 'BeforeToolSelection':
      return new BeforeToolSelectionHookOutput(data);
    case 'BeforeTool':
      return new BeforeToolHookOutput(data);
    case 'AfterAgent':
      return new AfterAgentHookOutput(data);
    default:
      return new DefaultHookOutput(data);
  }
}

/**
 * Default implementation of HookOutput with utility methods
 */
export class DefaultHookOutput implements HookOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  decision?: HookDecision;
  reason?: string;
  cancel?: boolean;
  hookSpecificOutput?: Record<string, unknown>;

  constructor(data: Partial<HookOutput> = {}) {
    this.continue = data.continue;
    this.stopReason = data.stopReason;
    this.suppressOutput = data.suppressOutput;
    this.systemMessage = data.systemMessage;
    this.decision = data.decision;
    this.reason = data.reason;
    this.cancel = data.cancel;
    this.hookSpecificOutput = data.hookSpecificOutput;
  }

  /**
   * Check if this output represents a blocking decision (block or deny)
   */
  isBlockingDecision(): boolean {
    return this.decision === 'block' || this.decision === 'deny';
  }

  /**
   * Check if this output represents an 'ask' decision
   */
  isAskDecision(): boolean {
    return this.decision === 'ask';
  }

  /**
   * Check if this output requests to stop execution
   */
  shouldStopExecution(): boolean {
    return this.continue === false;
  }

  /**
   * Get the effective reason for blocking or stopping
   */
  getEffectiveReason(): string {
    return this.stopReason || this.reason || 'No reason provided';
  }

  /**
   * Apply LLM request modifications (specific method for BeforeModel hooks)
   */
  applyLLMRequestModifications(
    target: GenerateContentParameters,
  ): GenerateContentParameters {
    // Base implementation - overridden by BeforeModelHookOutput
    return target;
  }

  /**
   * Apply tool config modifications (specific method for BeforeToolSelection hooks)
   */
  applyToolConfigModifications(target: {
    toolConfig?: GenAIToolConfig;
    tools?: ToolListUnion;
  }): {
    toolConfig?: GenAIToolConfig;
    tools?: ToolListUnion;
  } {
    // Base implementation - overridden by BeforeToolSelectionHookOutput
    return target;
  }

  /**
   * Get sanitized additional context for adding to responses.
   */
  getAdditionalContext(): string | undefined {
    if (
      this.hookSpecificOutput &&
      'additionalContext' in this.hookSpecificOutput
    ) {
      const context = this.hookSpecificOutput['additionalContext'];
      if (typeof context !== 'string') {
        return undefined;
      }

      // Sanitize by escaping < and > to prevent tag injection
      return context.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    return undefined;
  }

  /**
   * Check if execution should be blocked and return error info
   */
  getBlockingError(): { blocked: boolean; reason: string } {
    if (this.isBlockingDecision()) {
      return {
        blocked: true,
        reason: this.getEffectiveReason(),
      };
    }
    return { blocked: false, reason: '' };
  }

  /**
   * Check if context clearing was requested by hook.
   */
  shouldClearContext(): boolean {
    return false;
  }

  /**
   * Optional request to execute another tool immediately after this one.
   * The result of this tail call will replace the original tool's response.
   */
  getTailToolCallRequest():
    | {
        name: string;
        args: Record<string, unknown>;
      }
    | undefined {
    if (
      this.hookSpecificOutput &&
      'tailToolCallRequest' in this.hookSpecificOutput
    ) {
      const request = this.hookSpecificOutput['tailToolCallRequest'];
      if (
        typeof request === 'object' &&
        request !== null &&
        !Array.isArray(request)
      ) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return request as { name: string; args: Record<string, unknown> };
      }
    }
    return undefined;
  }
}

/**
 * Specific hook output class for BeforeTool events.
 */
export class BeforeToolHookOutput extends DefaultHookOutput {
  /**
   * Get modified tool input if provided by hook
   */
  getModifiedToolInput(): Record<string, unknown> | undefined {
    if (this.hookSpecificOutput && 'tool_input' in this.hookSpecificOutput) {
      const input = this.hookSpecificOutput['tool_input'];
      if (
        typeof input === 'object' &&
        input !== null &&
        !Array.isArray(input)
      ) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return input as Record<string, unknown>;
      }
    }
    return undefined;
  }
}

/**
 * Specific hook output class for BeforeModel events
 */
export class BeforeModelHookOutput extends DefaultHookOutput {
  /**
   * Get synthetic LLM response if provided by hook
   */
  getSyntheticResponse(): GenerateContentResponse | undefined {
    if (this.hookSpecificOutput && 'llm_response' in this.hookSpecificOutput) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const hookResponse = this.hookSpecificOutput[
        'llm_response'
      ] as LLMResponse;
      if (hookResponse) {
        // Convert hook format to SDK format
        return defaultHookTranslator.fromHookLLMResponse(hookResponse);
      }
    }
    return undefined;
  }

  /**
   * Apply modifications to LLM request
   */
  override applyLLMRequestModifications(
    target: GenerateContentParameters,
  ): GenerateContentParameters {
    if (this.hookSpecificOutput && 'llm_request' in this.hookSpecificOutput) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const hookRequest = this.hookSpecificOutput[
        'llm_request'
      ] as Partial<LLMRequest>;
      if (hookRequest) {
        // Convert hook format to SDK format
        const sdkRequest = defaultHookTranslator.fromHookLLMRequest(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          hookRequest as LLMRequest,
          target,
        );
        return {
          ...target,
          ...sdkRequest,
        };
      }
    }
    return target;
  }
}

/**
 * Specific hook output class for BeforeToolSelection events
 */
export class BeforeToolSelectionHookOutput extends DefaultHookOutput {
  /**
   * Apply tool configuration modifications
   */
  override applyToolConfigModifications(target: {
    toolConfig?: GenAIToolConfig;
    tools?: ToolListUnion;
  }): { toolConfig?: GenAIToolConfig; tools?: ToolListUnion } {
    if (this.hookSpecificOutput && 'toolConfig' in this.hookSpecificOutput) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const hookToolConfig = this.hookSpecificOutput[
        'toolConfig'
      ] as HookToolConfig;
      if (hookToolConfig) {
        // Convert hook format to SDK format
        const sdkToolConfig =
          defaultHookTranslator.fromHookToolConfig(hookToolConfig);
        return {
          ...target,
          tools: target.tools || [],
          toolConfig: sdkToolConfig,
        };
      }
    }
    return target;
  }
}

/**
 * Specific hook output class for AfterModel events
 */
export class AfterModelHookOutput extends DefaultHookOutput {
  /**
   * Get modified LLM response if provided by hook
   */
  getModifiedResponse(): GenerateContentResponse | undefined {
    if (this.hookSpecificOutput && 'llm_response' in this.hookSpecificOutput) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const hookResponse = this.hookSpecificOutput[
        'llm_response'
      ] as Partial<LLMResponse>;
      if (hookResponse?.candidates?.[0]?.content?.parts?.length) {
        // Convert hook format to SDK format
        return defaultHookTranslator.fromHookLLMResponse(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          hookResponse as LLMResponse,
        );
      }
    }

    return undefined;
  }
}

/**
 * Specific hook output class for AfterAgent events
 */
export class AfterAgentHookOutput extends DefaultHookOutput {
  /**
   * Check if context clearing was requested by hook
   */
  override shouldClearContext(): boolean {
    if (this.hookSpecificOutput && 'clearContext' in this.hookSpecificOutput) {
      return this.hookSpecificOutput['clearContext'] === true;
    }
    return false;
  }
}

/**
 * Context for MCP tool executions.
 * Contains non-sensitive connection information about the MCP server
 * identity. Since server_name is user controlled and arbitrary, we
 * also include connection information (e.g., command or url) to
 * help identify the MCP server.
 *
 * NOTE: In the future, consider defining a shared sanitized interface
 * from MCPServerConfig to avoid duplication and ensure consistency.
 */
export interface McpToolContext {
  server_name: string;
  tool_name: string; // Original tool name from the MCP server

  // Connection info (mutually exclusive based on transport type)
  command?: string; // For stdio transport
  args?: string[]; // For stdio transport
  cwd?: string; // For stdio transport

  url?: string; // For SSE/HTTP transport

  tcp?: string; // For WebSocket transport
}

/**
 * BeforeTool hook input
 */
export interface BeforeToolInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  mcp_context?: McpToolContext; // Only present for MCP tools
  original_request_name?: string;
}

/**
 * BeforeTool hook output
 */
export interface BeforeToolOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'BeforeTool';
    tool_input?: Record<string, unknown>;
  };
}

/**
 * AfterTool hook input
 */
export interface AfterToolInput extends HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  mcp_context?: McpToolContext; // Only present for MCP tools
  original_request_name?: string;
}

/**
 * AfterTool hook output
 */
export interface AfterToolOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'AfterTool';
    additionalContext?: string;
    /**
     * Optional request to execute another tool immediately after this one.
     * The result of this tail call will replace the original tool's response.
     */
    tailToolCallRequest?: {
      name: string;
      args: Record<string, unknown>;
    };
  };
}

/**
 * BeforeAgent hook input
 */
export interface BeforeAgentInput extends HookInput {
  prompt: string;
}

/**
 * BeforeAgent hook output
 */
export interface BeforeAgentOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'BeforeAgent';
    additionalContext?: string;
  };
}

/**
 * Notification types
 */
export enum NotificationType {
  ToolPermission = 'ToolPermission',
}

/**
 * Notification hook input
 */
export interface NotificationInput extends HookInput {
  notification_type: NotificationType;
  message: string;
  details: Record<string, unknown>;
}

/**
 * Notification hook output
 */
export interface NotificationOutput {
  suppressOutput?: boolean;
  systemMessage?: string;
}

/**
 * AfterAgent hook input
 */
export interface AfterAgentInput extends HookInput {
  prompt: string;
  prompt_response: string;
  stop_hook_active: boolean;
}

/**
 * AfterAgent hook output
 */
export interface AfterAgentOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'AfterAgent';
    clearContext?: boolean;
  };
}

/**
 * SessionStart source types
 */
export enum SessionStartSource {
  Startup = 'startup',
  Resume = 'resume',
  Clear = 'clear',
}

/**
 * SessionStart hook input
 */
export interface SessionStartInput extends HookInput {
  source: SessionStartSource;
}

/**
 * SessionStart hook output
 */
export interface SessionStartOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'SessionStart';
    additionalContext?: string;
  };
}

/**
 * SessionEnd reason types
 */
export enum SessionEndReason {
  Exit = 'exit',
  Clear = 'clear',
  Logout = 'logout',
  PromptInputExit = 'prompt_input_exit',
  Other = 'other',
}

/**
 * SessionEnd hook input
 */
export interface SessionEndInput extends HookInput {
  reason: SessionEndReason;
}

/**
 * PreCompress trigger types
 */
export enum PreCompressTrigger {
  Manual = 'manual',
  Auto = 'auto',
}

/**
 * PreCompress hook input
 */
export interface PreCompressInput extends HookInput {
  trigger: PreCompressTrigger;
}

/**
 * PreCompress hook output
 */
export interface PreCompressOutput {
  suppressOutput?: boolean;
  systemMessage?: string;
}

/**
 * BeforeModel hook input - uses decoupled types
 */
export interface BeforeModelInput extends HookInput {
  llm_request: LLMRequest;
}

/**
 * BeforeModel hook output
 */
export interface BeforeModelOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'BeforeModel';
    llm_request?: Partial<LLMRequest>;
    llm_response?: LLMResponse;
  };
}

/**
 * AfterModel hook input - uses decoupled types
 */
export interface AfterModelInput extends HookInput {
  llm_request: LLMRequest;
  llm_response: LLMResponse;
}

/**
 * AfterModel hook output
 */
export interface AfterModelOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'AfterModel';
    llm_response?: Partial<LLMResponse>;
  };
}

/**
 * BeforeToolSelection hook input - uses decoupled types
 */
export interface BeforeToolSelectionInput extends HookInput {
  llm_request: LLMRequest;
}

/**
 * BeforeToolSelection hook output
 */
export interface BeforeToolSelectionOutput extends HookOutput {
  hookSpecificOutput?: {
    hookEventName: 'BeforeToolSelection';
    toolConfig?: HookToolConfig;
  };
}

/**
 * TurnStart hook input - a model turn is about to be dispatched
 */
export interface TurnStartInput extends HookInput {
  prompt_id: string;
  /** Monotonic index of this turn within the session. */
  turn_index: number;
  model: string;
}

/**
 * TurnStart hook output
 *
 * Observation only: by the time a turn starts the request has already been
 * shaped by {@link HookEventName.BeforeModel}. Use that event to change it.
 */
export interface TurnStartOutput {
  suppressOutput?: boolean;
  systemMessage?: string;
}

/**
 * TurnEnd hook input - the turn dispatched at the matching TurnStart finished
 */
export interface TurnEndInput extends HookInput {
  prompt_id: string;
  /** Matches the `turn_index` reported by the paired TurnStart. */
  turn_index: number;
  model: string;
  /** Text the model produced this turn; empty when the turn produced none. */
  response_text: string;
  finish_reason?: string;
  /** True when the stream ended in an error event. */
  error: boolean;
  /** Tool calls the model requested this turn, by name. */
  tool_call_names: string[];
}

/**
 * TurnEnd hook output
 *
 * Observation only. The turn is already over; {@link HookEventName.AfterAgent}
 * is the event that can still change what happens next.
 */
export interface TurnEndOutput {
  suppressOutput?: boolean;
  systemMessage?: string;
}

/**
 * AutoCompactionStart hook input - automatic compaction is about to run
 */
export interface AutoCompactionStartInput extends HookInput {
  prompt_id: string;
  /** Model whose context window is being compacted. */
  model: string;
  /** Token count of the history before compaction. */
  original_token_count: number;
}

/**
 * AutoCompactionStart hook output
 */
export interface AutoCompactionStartOutput {
  suppressOutput?: boolean;
  systemMessage?: string;
}

/**
 * AutoCompactionEnd hook input - the automatic compaction has settled
 */
export interface AutoCompactionEndInput extends HookInput {
  prompt_id: string;
  model: string;
  /**
   * The `CompressionStatus` member *name* — `COMPRESSED`, `NOOP`,
   * `CONTENT_TRUNCATED`, or one of the failure statuses — rather than the
   * numeric enum value, because this reaches a hook command as JSON.
   */
  compression_status: string;
  original_token_count: number;
  new_token_count: number;
  /** True when compaction was attempted but decided there was nothing to do. */
  skipped: boolean;
}

/**
 * AutoCompactionEnd hook output
 */
export interface AutoCompactionEndOutput {
  suppressOutput?: boolean;
  systemMessage?: string;
}

/**
 * AutoRetryStart hook input - the model call is backing off before a retry
 */
export interface AutoRetryStartInput extends HookInput {
  attempt: number;
  max_attempts: number;
  delay_ms: number;
  error_message: string;
  error_type: string;
  model: string;
}

/**
 * AutoRetryStart hook output
 */
export interface AutoRetryStartOutput {
  suppressOutput?: boolean;
  systemMessage?: string;
}

/**
 * AutoRetryEnd hook input - the retry saga has settled
 */
export interface AutoRetryEndInput extends HookInput {
  /** Attempts made before the saga settled; 0 when no retry ever happened. */
  attempt: number;
  success: boolean;
  /** The error the saga gave up on, when `success` is false. */
  error_message?: string;
  model: string;
}

/**
 * AutoRetryEnd hook output
 */
export interface AutoRetryEndOutput {
  suppressOutput?: boolean;
  systemMessage?: string;
}

/**
 * BeforeSubagentSpawn hook input - a delegation is about to be dispatched
 */
export interface BeforeSubagentSpawnInput extends HookInput {
  /** Name of the subagent about to run, as the model spelled it. */
  agent_name: string;
  /** Where the subagent runs. */
  agent_kind: 'local' | 'remote';
  prompt: string;
  /** The mapped input the subagent actually receives, not the raw prompt. */
  agent_input: Record<string, unknown>;
  /**
   * True when this branch is one of several fanned out by a single batched
   * delegation, so a hook can tell "the only subagent" from "one of five".
   */
  batch: boolean;
}

/**
 * BeforeSubagentSpawn hook output
 */
export interface BeforeSubagentSpawnOutput extends HookOutput {
  /**
   * Set `cancel: true` to stop this delegation. The subagent never starts and
   * the model is told the delegation was refused, with `reason` as the
   * explanation.
   *
   * Fail-closed, as described on {@link HookOutput.cancel}: a hook that fails
   * is a refusal, not a pass.
   */
  cancel?: boolean;
}

/**
 * Hook execution result
 */
export interface HookExecutionResult {
  hookConfig: HookConfig;
  eventName: HookEventName;
  success: boolean;
  output?: HookOutput;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  duration: number;
  error?: Error;
  /** The format of the output provided by the hook */
  outputFormat?: 'json' | 'text';
}

/**
 * Hook execution plan for an event
 */
export interface HookExecutionPlan {
  eventName: HookEventName;
  hookConfigs: HookConfig[];
  sequential: boolean;
}
