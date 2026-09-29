/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  Kind,
  type ToolInvocation,
  type ToolResult,
  BaseToolInvocation,
  type ToolCallConfirmationDetails,
  type ExecuteOptions,
} from '../tools/tools.js';
import { type AgentLoopContext } from '../config/agent-loop-context.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { AgentDefinition, AgentInputs } from './types.js';
import { LocalSubagentInvocation } from './local-invocation.js';
import { RemoteAgentInvocation } from './remote-invocation.js';
import { LocalSessionInvocation } from './local-session-invocation.js';
import { RemoteSessionInvocation } from './remote-session-invocation.js';
import { BROWSER_AGENT_NAME } from './browser/browserAgentDefinition.js';
import { BrowserAgentInvocation } from './browser/browserAgentInvocation.js';
import type { AgentEvent } from '../agent/types.js';
import { formatUserHintsForModel } from '../utils/fastAckHelper.js';
import { partListUnionToString } from '../core/geminiRequest.js';
import { isRecord } from '../utils/markdownUtils.js';
import { runInDevTraceSpan } from '../telemetry/trace.js';
import {
  GeminiCliOperation,
  GEN_AI_AGENT_DESCRIPTION,
  GEN_AI_AGENT_NAME,
} from '../telemetry/constants.js';
import { AGENT_TOOL_NAME } from '../tools/tool-names.js';
import {
  finishAgent,
  mintAgentId,
  registerAgent,
  type AgentHandle,
} from './agentRegistry.js';

/**
 * A unified tool for invoking subagents.
 *
 * Handles looking up the subagent, validating its eligibility,
 * mapping the general 'prompt' parameter to the agent's specific schema,
 * and delegating execution.
 */
interface BatchTask {
  agent_name: string;
  prompt: string;
}

export interface AgentToolParams {
  agent_name?: string;
  prompt?: string;
  /** Shared background prepended to every prompt in a `tasks` batch. */
  context?: string;
  /** Several subagents to invoke in one parallel fan-out. */
  tasks?: BatchTask[];
}

export class AgentTool extends BaseDeclarativeTool<
  AgentToolParams,
  ToolResult
> {
  static readonly Name = AGENT_TOOL_NAME;

  constructor(
    private readonly context: AgentLoopContext,
    messageBus: MessageBus,
    private readonly onAgentEvent?: (event: AgentEvent) => void,
  ) {
    super(
      AGENT_TOOL_NAME,
      'Invoke Subagent',
      'Invoke a subagent to perform a specific task or investigation.',
      Kind.Agent,
      {
        type: 'object',
        properties: {
          agent_name: {
            type: 'string',
            description: 'Name of the subagent to invoke.',
          },
          prompt: {
            type: 'string',
            description:
              'The COMPLETE query to send the subagent. MUST be comprehensive and detailed. Include all context, background, questions, and expected output format. Do NOT send brief or incomplete instructions.',
          },
          context: {
            type: 'string',
            description:
              'Only with `tasks`. Shared background every subagent in the batch needs; it is prepended to each task prompt so no subagent has to be told what the others already know.',
          },
          tasks: {
            type: 'array',
            description:
              'Invoke several subagents in ONE call. Use this when the work is genuinely independent: it saves a round trip and makes the parallelism explicit. Independent work here is safe; work that touches the same files should be delegated one at a time.',
            items: {
              type: 'object',
              properties: {
                agent_name: { type: 'string' },
                prompt: { type: 'string' },
              },
              required: ['agent_name', 'prompt'],
            },
          },
        },
        required: [],
      },
      messageBus,
      /* isOutputMarkdown */ true,
      /* canUpdateOutput */ true,
    );
  }

  protected override validateToolParamValues(
    params: AgentToolParams,
  ): string | null {
    const hasBatch = Array.isArray(params.tasks) && params.tasks.length > 0;
    const hasSingle =
      typeof params.agent_name === 'string' &&
      typeof params.prompt === 'string' &&
      params.agent_name !== '' &&
      params.prompt !== '';
    if (hasBatch === hasSingle) {
      return 'Provide either agent_name and prompt, or a non-empty tasks array — not both and not neither.';
    }
    if (hasBatch) {
      for (const [index, task] of params.tasks!.entries()) {
        if (!task.agent_name || !task.prompt) {
          return `tasks[${index}] needs both agent_name and prompt.`;
        }
      }
    }
    return null;
  }

  protected createInvocation(
    params: AgentToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<AgentToolParams, ToolResult> {
    if (Array.isArray(params.tasks) && params.tasks.length > 0) {
      return new BatchDelegateInvocation(
        params.tasks,
        params.context,
        messageBus,
        this.context,
        _toolName ?? AGENT_TOOL_NAME,
        _toolDisplayName ?? 'Invoke Subagents',
        this.onAgentEvent,
      );
    }
    const definition = this.requireDefinition(params.agent_name!);
    return new DelegateInvocation(
      { agent_name: params.agent_name!, prompt: params.prompt! },
      this.mapParamsFor(definition, params.prompt!),
      messageBus,
      definition,
      this.context,
      _toolName,
      _toolDisplayName,
      this.onAgentEvent,
    );
  }

  private requireDefinition(name: string) {
    const definition = this.context.config
      .getAgentRegistry()
      .getDefinition(name);
    if (!definition) {
      throw new Error(`Subagent '${name}' not found.`);
    }
    return definition;
  }

  private mapParamsFor(
    definition: AgentDefinition,
    prompt: string,
  ): AgentInputs {
    return this.mapParams(prompt, definition.inputConfig.inputSchema);
  }

  private mapParams(prompt: string, schema: unknown): AgentInputs {
    const schemaObj: unknown = schema;
    if (!isRecord(schemaObj)) {
      return { prompt };
    }
    const properties = schemaObj['properties'];
    if (isRecord(properties)) {
      const keys = Object.keys(properties);
      if (keys.length === 1) {
        return { [keys[0]]: prompt };
      }
    }
    return { prompt };
  }
}

class DelegateInvocation extends BaseToolInvocation<
  { agent_name: string; prompt: string },
  ToolResult
> {
  private readonly startIndex: number;

  constructor(
    params: { agent_name: string; prompt: string },
    private readonly mappedInputs: AgentInputs,
    messageBus: MessageBus,
    private readonly definition: AgentDefinition,
    private readonly context: AgentLoopContext,
    _toolName?: string,
    _toolDisplayName?: string,
    private readonly onAgentEvent?: (event: AgentEvent) => void,
    /**
     * True when this branch is one of several dispatched by a single batched
     * call, so a BeforeSubagentSpawn hook can tell "the only subagent" from
     * "one of five".
     */
    private readonly batch: boolean = false,
  ) {
    super(
      params,
      messageBus,
      _toolName ?? AGENT_TOOL_NAME,
      _toolDisplayName ?? `Invoke ${definition.displayName ?? definition.name}`,
    );
    this.startIndex = context.config.injectionService.getLatestInjectionIndex();
  }

  getDescription(): string {
    return `Delegating to agent '${this.definition.name}'`;
  }

  private buildChildInvocation(
    agentArgs: AgentInputs,
  ): ToolInvocation<AgentInputs, ToolResult> {
    if (this.definition.name === BROWSER_AGENT_NAME) {
      return new BrowserAgentInvocation(
        this.context,
        agentArgs,
        this.messageBus,
        this._toolName,
        this._toolDisplayName,
      );
    }

    const useSession = this.context.config.isAgentSessionSubagentEnabled();
    const options = this.onAgentEvent
      ? { onAgentEvent: this.onAgentEvent }
      : undefined;

    if (this.definition.kind === 'remote') {
      if (useSession) {
        return new RemoteSessionInvocation(
          this.definition,
          this.context,
          agentArgs,
          this.messageBus,
          options,
        );
      }
      return new RemoteAgentInvocation(
        this.definition,
        this.context,
        agentArgs,
        this.messageBus,
      );
    } else {
      if (useSession) {
        return new LocalSessionInvocation(
          this.definition,
          this.context,
          agentArgs,
          this.messageBus,
          options,
        );
      }
      return new LocalSubagentInvocation(
        this.definition,
        this.context,
        agentArgs,
        this.messageBus,
      );
    }
  }

  override async shouldConfirmExecute(
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const hintedParams = this.withUserHints(this.mappedInputs);
    const invocation = this.buildChildInvocation(hintedParams);
    return invocation.shouldConfirmExecute(abortSignal);
  }

  async execute(options: ExecuteOptions): Promise<ToolResult> {
    const { abortSignal: signal, updateOutput } = options;
    const hintedParams = this.withUserHints(this.mappedInputs);

    // Before the child invocation is even built: a refused delegation must not
    // construct an executor, mint a roster handle, or open a trace span for
    // work that will never happen.
    const hookSystem = this.context.config.getEnableHooks()
      ? this.context.config.getHookSystem()
      : undefined;
    const decision = await hookSystem?.fireBeforeSubagentSpawnEvent({
      agent_name: this.definition.name,
      agent_kind: this.definition.kind,
      prompt: this.params.prompt,
      agent_input: { ...hintedParams },
      batch: this.batch,
    });
    if (decision?.cancelled) {
      return refusedSpawn(this.definition.name, decision.reason);
    }

    const invocation = this.buildChildInvocation(hintedParams);

    // Every subagent goes on the roster while it runs, so a sibling can
    // address it with `agent://<id>` and `wait` knows a message can still end
    // a wait. The handle is settled on every exit path.
    const injections = this.context.config.injectionService;
    const id = mintAgentId(undefined);
    const handle: AgentHandle = {
      id,
      name: this.definition.name,
      parentId: undefined,
      task: String(this.mappedInputs['prompt'] ?? ''),
      startedAt: Date.now(),
      status: 'running',
      deliver(message: string) {
        // A settled agent cannot take a message, and saying so beats silently
        // dropping it — the sender can then stop waiting for a reply.
        if (handle.status !== 'running') return 'failed';
        injections.addInjection(
          `Message from agent ${id}: ${message}`,
          'user_steering',
        );
        return 'delivered';
      },
      transcript: () => '',
    };
    registerAgent(handle);

    return runInDevTraceSpan(
      {
        operation: GeminiCliOperation.AgentCall,
        logPrompts: this.context.config.getTelemetryLogPromptsEnabled(),
        tracesEnabled: this.context.config.getTelemetryTracesEnabled(),
        sessionId: this.context.config.getSessionId(),
        attributes: {
          [GEN_AI_AGENT_NAME]: this.definition.name,
          [GEN_AI_AGENT_DESCRIPTION]: this.definition.description,
        },
      },
      async ({ metadata }) => {
        metadata.input = this.params;
        try {
          const result = await invocation.execute({
            abortSignal: signal,
            updateOutput,
          });
          metadata.output = result;
          finishAgent(
            id,
            result.error === undefined ? 'done' : 'aborted',
            result.data,
          );
          return result;
        } catch (err) {
          finishAgent(id, 'aborted');
          throw err;
        }
      },
    );
  }

  private withUserHints(agentArgs: AgentInputs): AgentInputs {
    if (this.definition.kind !== 'remote') {
      return agentArgs;
    }

    const userHints = this.context.config.injectionService.getInjectionsAfter(
      this.startIndex,
      'user_steering',
    );
    const formattedHints = formatUserHintsForModel(userHints);
    if (!formattedHints) {
      return agentArgs;
    }

    // Find the primary key to append hints to
    const schemaObj: unknown = this.definition.inputConfig.inputSchema;
    if (!isRecord(schemaObj)) {
      return agentArgs;
    }
    const properties = schemaObj['properties'];
    if (isRecord(properties)) {
      const keys = Object.keys(properties);
      const primaryKey = keys.length === 1 ? keys[0] : 'prompt';

      const value = agentArgs[primaryKey];
      if (typeof value !== 'string' || value.trim().length === 0) {
        return agentArgs;
      }

      return {
        ...agentArgs,
        [primaryKey]: `${formattedHints}\n\n${value}`,
      };
    }

    return agentArgs;
  }
}

/**
 * A fan-out of subagents in one call.
 *
 * Ported from omp's `task.batch`. The point is not just saving a round trip:
 * naming the parallel work in one place makes the parallelism explicit, and a
 * single result the parent can read per branch is easier to verify than three
 * separate tool calls it has to correlate.
 *
 * One branch failing does not void the others — a partial answer is still
 * usable, and the failure says which branch it was.
 */
class BatchDelegateInvocation extends BaseToolInvocation<
  AgentToolParams,
  ToolResult
> {
  constructor(
    private readonly tasks: BatchTask[],
    private readonly sharedContext: string | undefined,
    messageBus: MessageBus,
    private readonly agentContext: AgentLoopContext,
    toolName?: string,
    toolDisplayName?: string,
    private readonly onAgentEvent?: (event: AgentEvent) => void,
  ) {
    super({ tasks }, messageBus, toolName, toolDisplayName);
  }

  override getDescription(): string {
    return `Delegating to ${this.tasks.length} subagents in parallel`;
  }

  override async execute(options: ExecuteOptions): Promise<ToolResult> {
    const registry = this.agentContext.config.getAgentRegistry();
    const started = this.tasks.map((task) => {
      const definition = registry.getDefinition(task.agent_name);
      if (!definition) {
        return { task, error: `Subagent '${task.agent_name}' not found.` };
      }
      const prompt = this.sharedContext
        ? `${this.sharedContext}\\n\\n---\\n\\n${task.prompt}`
        : task.prompt;
      const mapped = mapAgentInputs(prompt, definition.inputConfig.inputSchema);
      const invocation = new DelegateInvocation(
        { agent_name: task.agent_name, prompt },
        mapped,
        this.messageBus,
        definition,
        this.agentContext,
        undefined,
        undefined,
        this.onAgentEvent,
        /* batch */ true,
      );
      return { task, invocation };
    });

    // Every branch is dispatched even if an earlier one is broken: the point
    // of a fan-out is the independent work, and one bad name is not a reason
    // to skip the other four.
    const settled = await Promise.allSettled(
      started.map(async (entry) => {
        if ('error' in entry) {
          return { name: entry.task.agent_name, error: entry.error };
        }
        const result = await entry.invocation.execute(options);
        return { name: entry.task.agent_name, result };
      }),
    );

    const sections: string[] = [];
    let failures = 0;
    for (const [index, outcome] of settled.entries()) {
      const name = started[index].task.agent_name;
      if (outcome.status === 'rejected') {
        failures++;
        sections.push(`### ${name}\\nFAILED: ${String(outcome.reason)}`);
        continue;
      }
      const settledValue = outcome.value;
      // A branch can fail in two ways: the dispatch itself rejects, or the
      // subagent reports failure as a tool error. Only the first is visible
      // from the settled outcome, so the second is checked on the result —
      // otherwise a failed branch is counted as a success and the parent
      // trusts a summary that overstates what the fan-out achieved.
      if (!('result' in settledValue)) {
        failures++;
        sections.push(`### ${name}\\nFAILED: ${String(settledValue.error)}`);
        continue;
      }
      const result = settledValue.result;
      if (result?.error !== undefined) {
        failures++;
        sections.push(`### ${name}\\nFAILED: ${String(result.error.message)}`);
        continue;
      }
      // `llmContent` is a part list, not a string: stringifying it directly
      // yields "[object Object]", which tells the caller nothing.
      sections.push(
        result === undefined
          ? `### ${name}\\n(no result)`
          : `### ${name}\\n${partListUnionToString(result.llmContent)}`,
      );
    }

    const summary = `Ran ${this.tasks.length} subagents in parallel; ${this.tasks.length - failures} succeeded, ${failures} failed.`;
    return {
      llmContent: `${summary}\\n\\n${sections.join('\\n\\n')}`,
      returnDisplay: summary,
    };
  }
}

/**
 * The result of a delegation a `BeforeSubagentSpawn` hook refused.
 *
 * Carries `error` as well as prose on purpose. Without it the model sees a
 * successful tool call that returned a sentence, and the natural reading is
 * "the subagent ran and had nothing to say" — so it delegates again, to the
 * same refusal, until the turn budget runs out. As a failure the model
 * treats it as a blocked operation and changes course.
 */
function refusedSpawn(agentName: string, reason?: string): ToolResult {
  const explanation =
    reason ?? 'a BeforeSubagentSpawn hook refused this delegation';
  const message = `Subagent '${agentName}' was not started: ${explanation}`;
  return {
    llmContent: message,
    returnDisplay: message,
    error: { message },
  };
}

/**
 * Map a prompt onto an agent's single-parameter input schema.
 *
 * Shared by the single and batch paths so a fanned-out subagent is given its
 * arguments exactly the way a directly-invoked one is.
 */
function mapAgentInputs(prompt: string, schema: unknown): AgentInputs {
  const schemaObj: unknown = schema;
  if (!isRecord(schemaObj)) {
    return { prompt };
  }
  const properties = schemaObj['properties'];
  if (isRecord(properties)) {
    const keys = Object.keys(properties);
    if (keys.length === 1) {
      return { [keys[0]]: prompt };
    }
  }
  return { prompt };
}
