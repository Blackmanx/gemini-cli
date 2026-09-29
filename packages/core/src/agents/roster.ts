/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  listAgents,
  type AgentHandle,
  type AgentStatus,
} from './agentRegistry.js';

/**
 * The agent roster: the live agent tree, as text.
 *
 * Ported from omp's Agent Hub. The hub is a view, not a control surface - it
 * answers "what is running right now, and what is each one doing", which is
 * the question you have when a fan-out of subagents is in flight and the
 * terminal looks idle.
 *
 * It is rendered here rather than as an Ink overlay so it can be printed into
 * the transcript: an overlay vanishes on the next keystroke, and the moment
 * someone actually needs this view is usually after the fact.
 */

/** How a task is shown when it is long. */
const MAX_TASK_CHARS = 68;

const STATUS_MARK: Record<AgentStatus, string> = {
  running: '*',
  idle: '~',
  done: '+',
  aborted: 'x',
};

/** Short, human duration. Precision nobody acts on is noise. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m${String(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h${String(minutes % 60)}m`;
}

function oneLine(text: string, max = MAX_TASK_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '(no task)';
  if (flat.length <= max) return flat;
  // Cut on a word boundary when there is one, so the visible task reads as a
  // task rather than as a truncated fragment.
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

function hasResult(agent: AgentHandle): boolean {
  const result = agent.result;
  if (result === undefined || result === null) return false;
  if (typeof result === 'string') return result.trim() !== '';
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === 'object') return Object.keys(result).length > 0;
  return true;
}

export interface RosterOptions {
  /** `Date.now()`, injected so a caller can render a consistent snapshot. */
  now?: number;
  /** Include agents that have already finished. */
  includeSettled?: boolean;
}

/**
 * The whole agent tree, parents above children.
 *
 * An agent whose parent is not in the list - it was pruned, or the list is a
 * filtered view - is drawn at the root. Dropping it would hide a real agent
 * that is really running.
 */
export function formatAgentRoster(options: RosterOptions = {}): string {
  const now = options.now ?? Date.now();
  const all = listAgents();
  const agents = options.includeSettled
    ? all
    : all.filter((a) => a.status === 'running' || a.status === 'idle');
  if (agents.length === 0) {
    return all.length === 0
      ? 'No agents have been started in this session.'
      : 'No agents are running. All settled.';
  }

  const present = new Set(agents.map((a) => a.id));
  const childrenOf = (parentId: string): AgentHandle[] =>
    agents.filter((a) => a.parentId === parentId);
  const roots = agents.filter(
    (a) => a.parentId === undefined || !present.has(a.parentId),
  );

  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (agent: AgentHandle, depth: number): void => {
    // A cycle in parent links would otherwise recurse forever; ids are
    // assigned by the registry, but rendering must not depend on that.
    if (seen.has(agent.id)) return;
    seen.add(agent.id);

    const mark = STATUS_MARK[agent.status];
    const elapsed = formatElapsed(now - agent.startedAt);
    const indent = '  '.repeat(depth);
    const connector = depth === 0 ? '' : '`- ';
    const head = `${indent}${connector}${mark} ${agent.name} (${agent.id})  ${elapsed}`;
    const tail = hasResult(agent) ? '  [result]' : '';
    lines.push(`${head}  ${oneLine(agent.task)}${tail}`);

    for (const child of childrenOf(agent.id)) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }

  const running = all.filter((a) => a.status === 'running').length;
  const summary =
    `${String(agents.length)} shown` +
    (options.includeSettled ? ` of ${String(all.length)}` : '') +
    `, ${String(running)} running.`;
  return `${lines.join('\n')}\n\n${summary}`;
}

/**
 * What each agent is doing, without the tree.
 *
 * One line per agent, in id order, so a diff between two hub views lines up.
 */
export function formatAgentActivity(): string {
  const agents = listAgents();
  if (agents.length === 0)
    return 'No agents have been started in this session.';
  const now = Date.now();
  return agents
    .map(
      (a) =>
        `${STATUS_MARK[a.status]} ${a.id}  ${a.name}  ` +
        `${formatElapsed(now - a.startedAt)}  ${a.status}  ${oneLine(a.task, 48)}`,
    )
    .join('\n');
}
