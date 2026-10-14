/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { HierarchicalMemory } from '../config/memory.js';
import { GEMINI_DIR, homedir, makeRelative } from '../utils/paths.js';
import { ApprovalMode } from '../policy/types.js';
import * as snippets from './snippets.js';
import * as legacySnippets from './snippets.legacy.js';
import {
  resolvePathFromEnv,
  applySubstitutions,
  isSectionEnabled,
  type ResolvedPath,
} from './utils.js';
import { CodebaseInvestigatorAgent } from '../agents/codebase-investigator.js';
import { isGitRepository } from '../utils/gitUtils.js';
import {
  TODO_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  AGENT_TOOL_NAME,
} from '../tools/tool-names.js';
import { resolveModel, supportsModernFeatures } from '../config/models.js';
import { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import {
  getAllGeminiMdFilenames,
  getGlobalMemoryFilePath,
  getProjectMemoryIndexFilePath,
} from '../tools/memoryTool.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';

/**
 * System prompt for a non-interactive run that still has to do real work.
 *
 * Deliberately short. The tool schemas already tell the model what it can
 * call and what each call needs; the composed prompt mostly restates that in
 * prose, along with sections describing a UI this run has no access to.
 * What is kept is the part the model cannot recover from the schemas: that it
 * is an agent with a workspace, and that it must finish the task rather than
 * narrate it.
 */
function renderSlimHeadlessPrompt(): string {
  return `You are Gemini CLI, a non-interactive coding agent operating on a user's workspace.

You have tools to read, search and edit files and to run shell commands. Use them to complete the task; do not ask the user questions, because there is nobody to answer them in this mode.

- Finish the task. Report the outcome in your final message, including what you changed and anything you could not do.
- Do not describe what you are about to do instead of doing it.
- Do not print file contents back to the user unless asked; reference files by path.`;
}

/**
 * System prompt for a plain one-shot text call, with no tools.
 *
 * `omp.headlessHarness: "api"` sends no tool schemas and no session context,
 * so the model cannot touch the filesystem and nothing tells it about one.
 * Saying so is not a nicety: a model that believes it has tools will ask for
 * them, and it will be right to, since they are not coming.
 */
function renderApiPrompt(): string {
  return `You are a text assistant. You have no tools and no access to the filesystem, so you cannot read, search or modify files. Answer from the conversation alone, and say plainly when a request needs something you cannot reach.`;
}

/**
 * Orchestrates prompt generation by gathering context and building options.
 */
export class PromptProvider {
  /**
   * Generates the core system prompt.
   */
  getCoreSystemPrompt(
    context: AgentLoopContext,
    userMemory?: string | HierarchicalMemory,
    interactiveOverride?: boolean,
    topicUpdateNarrationOverride?: boolean,
  ): string {
    const systemMdResolution = resolvePathFromEnv(
      process.env['GEMINI_SYSTEM_MD'],
    );

    const interactiveMode =
      interactiveOverride ?? context.config.isInteractive();
    const approvalMode =
      context.config.getApprovalMode?.() ?? ApprovalMode.DEFAULT;
    const isPlanMode = approvalMode === ApprovalMode.PLAN;
    const isYoloMode = approvalMode === ApprovalMode.YOLO;
    const skills = context.config.getSkillManager().getSkills();
    const toolNames = context.toolRegistry.getAllToolNames();
    const isTopicUpdateNarrationEnabled =
      topicUpdateNarrationOverride ??
      context.config.isTopicUpdateNarrationEnabled();

    const enabledToolNames = new Set(toolNames);

    const approvedPlanPath = context.config.getApprovedPlanPath();

    const desiredModel = resolveModel(
      context.config.getActiveModel(),
      context.config.getGemini31LaunchedSync?.() ?? false,
      false,
      context.config.getHasAccessToPreviewModel?.() ?? true,
      context.config,
      context.config.hasGemini35FlashGAAccess?.() ?? false,
    );
    const isModernModel = supportsModernFeatures(desiredModel);
    const activeSnippets = isModernModel ? snippets : legacySnippets;
    const contextFilenames = getAllGeminiMdFilenames();

    let trackerDir = context.config.isTrackerEnabled()
      ? context.config.storage.getProjectTempTrackerDir()
      : undefined;

    if (trackerDir) {
      // Sanitize path to prevent prompt injection
      trackerDir = trackerDir.replace(/\n/g, ' ').replace(/\]/g, '');
    }

    // --- Context Gathering ---
    let planModeToolsList = '';
    if (isPlanMode) {
      const allTools = context.toolRegistry.getAllTools();
      planModeToolsList = allTools
        .map((t) => {
          if (t instanceof DiscoveredMCPTool) {
            return `  <tool>\`${t.name}\` (${t.serverName})</tool>`;
          }
          return `  <tool>\`${t.name}\`</tool>`;
        })
        .join('\n');
    }

    let basePrompt: string;

    // A non-interactive run is a fresh process on every invocation, so the
    // composed prompt is paid for again each time, with no cache to amortize
    // it. When the user opts in, send a short prompt instead.
    //
    // GEMINI_SYSTEM_MD still wins: someone who wrote their own prompt is not
    // the one paying for this, and they have already made the same call.
    const harness = context.config.getHeadlessHarness?.() ?? 'full';
    const systemMdPathValue = systemMdResolution.value;
    const hasSystemMdOverride =
      !!systemMdPathValue && !systemMdResolution.isDisabled;
    const useMinimalPrompt =
      !hasSystemMdOverride && !interactiveMode && harness !== 'full';

    // --- Template File Override ---
    if (useMinimalPrompt) {
      basePrompt =
        harness === 'api' ? renderApiPrompt() : renderSlimHeadlessPrompt();
    } else if (hasSystemMdOverride) {
      let systemMdPath = path.resolve(path.join(GEMINI_DIR, 'system.md'));
      if (!systemMdResolution.isSwitch && systemMdPathValue) {
        systemMdPath = systemMdPathValue;
      }
      if (!fs.existsSync(systemMdPath)) {
        throw new Error(`missing system prompt file '${systemMdPath}'`);
      }
      basePrompt = fs.readFileSync(systemMdPath, 'utf8');
      const skillsPrompt = activeSnippets.renderAgentSkills(
        skills.map((s) => ({
          name: s.name,
          description: s.description,
          location: s.location,
        })),
      );
      basePrompt = applySubstitutions(
        basePrompt,
        context.config,
        skillsPrompt,
        isModernModel,
      );
    } else {
      // --- Standard Composition ---
      const hasHierarchicalMemory =
        typeof userMemory === 'object' &&
        userMemory !== null &&
        (!!userMemory.global?.trim() ||
          !!userMemory.extension?.trim() ||
          !!userMemory.project?.trim());

      const options: snippets.SystemPromptOptions = {
        preamble: this.withSection('preamble', () => ({
          interactive: interactiveMode,
          approvalMode,
        })),
        coreMandates: this.withSection('coreMandates', () => ({
          interactive: interactiveMode,
          hasSkills: skills.length > 0,
          hasHierarchicalMemory,
          contextFilenames,
          topicUpdateNarration: isTopicUpdateNarrationEnabled,
        })),
        subAgents: this.withSection(
          'agentContexts',
          () =>
            context.config
              .getAgentRegistry()
              .getAllDefinitions()
              .map((d) => ({
                name: d.name,
                description: d.description,
              })),
          enabledToolNames.has(AGENT_TOOL_NAME),
        ),
        agentSkills: this.withSection(
          'agentSkills',
          () =>
            skills.map((s) => ({
              name: s.name,
              description: s.description,
              location: s.location,
            })),
          skills.length > 0,
        ),
        taskTracker: trackerDir,
        hookContext: isSectionEnabled('hookContext') || undefined,
        primaryWorkflows: this.withSection(
          'primaryWorkflows',
          () => {
            const agentRegistry = context.config.getAgentRegistry();
            return {
              interactive: interactiveMode,
              enableCodebaseInvestigator:
                agentRegistry.getDefinition(CodebaseInvestigatorAgent.name) !==
                undefined,
              enableWriteTodosTool: enabledToolNames.has(TODO_TOOL_NAME),
              enableEnterPlanModeTool: enabledToolNames.has(
                ENTER_PLAN_MODE_TOOL_NAME,
              ),
              enableGrep: enabledToolNames.has(GREP_TOOL_NAME),
              enableGlob: enabledToolNames.has(GLOB_TOOL_NAME),
              approvedPlan: approvedPlanPath
                ? { path: approvedPlanPath }
                : undefined,
              taskTracker: trackerDir,
              topicUpdateNarration: isTopicUpdateNarrationEnabled,
            };
          },
          !isPlanMode,
        ),
        planningWorkflow: this.withSection(
          'planningWorkflow',
          () => ({
            interactive: interactiveMode,
            planModeToolsList,
            plansDir: makeRelative(
              context.config.storage.getPlansDir(),
              context.config.getProjectRoot(),
            ).replaceAll('\\', '/'),
            approvedPlanPath: (() => {
              const approvedPath = context.config.getApprovedPlanPath();
              return approvedPath
                ? makeRelative(
                    approvedPath,
                    context.config.getProjectRoot(),
                  ).replaceAll('\\', '/')
                : undefined;
            })(),
          }),
          isPlanMode,
        ),
        operationalGuidelines: this.withSection(
          'operationalGuidelines',
          () => ({
            interactive: interactiveMode,
            enableShellEfficiency:
              context.config.getEnableShellOutputEfficiency(),
            interactiveShellEnabled: context.config.isInteractiveShellEnabled(),
            topicUpdateNarration: isTopicUpdateNarrationEnabled,
            userProjectMemoryPath: normalizePromptPath(
              getProjectMemoryIndexFilePath(context.config.storage),
            ),
            globalMemoryPath: normalizePromptPath(getGlobalMemoryFilePath()),
          }),
        ),
        sandbox: this.withSection('sandbox', () => ({
          mode: getSandboxMode(),
          toolSandboxingEnabled: context.config.getSandboxEnabled(),
        })),
        interactiveYoloMode: this.withSection(
          'interactiveYoloMode',
          () => true,
          isYoloMode && interactiveMode,
        ),
        gitRepo: this.withSection(
          'git',
          () => ({ interactive: interactiveMode }),
          isGitRepository(process.cwd()) ? true : false,
        ),
        finalReminder: isModernModel
          ? undefined
          : this.withSection('finalReminder', () => ({
              readFileToolName: READ_FILE_TOOL_NAME,
            })),
      } as snippets.SystemPromptOptions;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const getCoreSystemPrompt = activeSnippets.getCoreSystemPrompt as (
        options: snippets.SystemPromptOptions,
      ) => string;
      basePrompt = getCoreSystemPrompt(options);
    }

    // The user's own standing instructions, and the conventions this repo
    // carries for other agents.
    //
    // The instructions go through `applySubstitutions`, so a user who writes
    // `${AvailableTools}` in their house rules gets it resolved exactly as it
    // would in GEMINI_SYSTEM_MD. Appending the raw text would ship a literal
    // `${...}` to the model, which reads as a broken template rather than as
    // what the user wrote.
    const skillsPrompt = activeSnippets.renderAgentSkills(
      skills.map((s) => ({
        name: s.name,
        description: s.description,
        location: s.location,
      })),
    );
    const append = this.readAppendSystem(context);
    if (append !== '') {
      const rendered = applySubstitutions(
        append,
        context.config,
        skillsPrompt,
        isModernModel,
      );
      basePrompt += `\n\n# User instructions\n\n${rendered}`;
    }
    // Appended as a distinct block, after the user's own memory, so a rule
    // the agent did not write stays attributable rather than blending in.
    const importedRules = context.config.getImportedRulesBlock?.();
    if (importedRules) {
      basePrompt += `\n\n${importedRules}`;
    }

    const finalPrompt = activeSnippets.renderFinalShell(
      basePrompt,
      userMemory,
      contextFilenames,
    );

    // Sanitize erratic newlines from composition
    let sanitizedPrompt = finalPrompt.replace(/\n{3,}/g, '\n\n');

    // Context Reinjection (Active Topic)
    if (isTopicUpdateNarrationEnabled) {
      const activeTopic = context.config.topicState.getTopic();
      if (activeTopic) {
        const sanitizedTopic = activeTopic
          .replace(/\n/g, ' ')
          .replace(/\]/g, '');
        sanitizedPrompt += `\n\n[Active Topic: ${sanitizedTopic}]`;
      }
    }

    // Write back to file if requested
    this.maybeWriteSystemMd(
      sanitizedPrompt,
      systemMdResolution,
      path.resolve(path.join(GEMINI_DIR, 'system.md')),
    );

    return sanitizedPrompt;
  }

  getCompressionPrompt(context: AgentLoopContext): string {
    const desiredModel = resolveModel(
      context.config.getActiveModel(),
      context.config.getGemini31LaunchedSync?.() ?? false,
      false,
      context.config.getHasAccessToPreviewModel?.() ?? true,
      context.config,
      context.config.hasGemini35FlashGAAccess?.() ?? false,
    );
    const isModernModel = supportsModernFeatures(desiredModel);
    const activeSnippets = isModernModel ? snippets : legacySnippets;
    return activeSnippets.getCompressionPrompt(
      context.config.getApprovedPlanPath(),
    );
  }

  private withSection<T>(
    key: string,
    factory: () => T,
    guard: boolean = true,
  ): T | undefined {
    return guard && isSectionEnabled(key) ? factory() : undefined;
  }

  /**
   * The user's standing instructions, from settings and `APPEND_SYSTEM.md`.
   *
   * Both are ADDITIVE. The existing way to customise the prompt is to replace
   * it wholesale via `GEMINI_SYSTEM_MD`, which silently drops every generated
   * section; this lets a user add house rules and keep them.
   *
   * `<cwd>/APPEND_SYSTEM.md` wins over the global one, matching how every
   * other project-scoped file in this repo behaves.
   */
  private readAppendSystem(context: AgentLoopContext): string {
    // Every step here is best-effort: this function reads OPTIONAL files, and a
    // prompt that throws because one is missing would take down the session.
    // A config that cannot say what its target directory is falls back to the
    // global file rather than failing.
    const targetDir = context.config.getTargetDir?.();
    const candidates = [
      ...(targetDir === undefined
        ? []
        : [path.join(targetDir, 'APPEND_SYSTEM.md')]),
      path.join(homedir(), '.gemini', 'APPEND_SYSTEM.md'),
    ];
    for (const file of candidates) {
      try {
        const text = fs.readFileSync(file, 'utf8').trim();
        if (text !== '') return text;
      } catch {
        // A missing or unreadable file simply contributes nothing.
      }
    }
    return context.config.getAppendSystemPrompt?.()?.trim() ?? '';
  }

  private maybeWriteSystemMd(
    basePrompt: string,
    resolution: ResolvedPath,
    defaultPath: string,
  ): void {
    const writeSystemMdResolution = resolvePathFromEnv(
      process.env['GEMINI_WRITE_SYSTEM_MD'],
    );
    if (writeSystemMdResolution.value && !writeSystemMdResolution.isDisabled) {
      const writePath = writeSystemMdResolution.isSwitch
        ? defaultPath
        : writeSystemMdResolution.value;
      fs.mkdirSync(path.dirname(writePath), { recursive: true });
      fs.writeFileSync(writePath, basePrompt);
    }
  }
}

function normalizePromptPath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

// --- Internal Context Helpers ---

function getSandboxMode(): snippets.SandboxMode {
  if (process.env['SANDBOX'] === 'sandbox-exec') return 'macos-seatbelt';
  if (process.env['SANDBOX']) return 'generic';
  return 'outside';
}
