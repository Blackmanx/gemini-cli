/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A roster of the subagents this process has running.
 *
 * Ported from omp's `registry/` + `irc/`. Two things depend on it: the `wait`
 * barrier needs to know whether a sibling can still end a wait, and the
 * `agent://` URL scheme needs somewhere to read a sibling's result from.
 * Without an addressable registry with stable ids there is nothing to steer,
 * read, or wake.
 */

/** How far through its life an agent is. */
export type AgentStatus = 'running' | 'idle' | 'done' | 'aborted';

/** How a message reached its recipient. */
export type DeliveryReceipt = 'delivered' | 'queued' | 'woke' | 'failed';

/** What the registry knows about one agent. */
export interface AgentHandle {
  /** Stable id for the life of the process. Dot-separated for nesting. */
  readonly id: string;
  /** The agent definition's name, e.g. `generalist`. */
  readonly name: string;
  /** The agent that spawned this one, when it is a subagent. */
  readonly parentId: string | undefined;
  /** The task this agent was given, for the roster view. */
  readonly task: string;
  readonly startedAt: number;
  status: AgentStatus;
  /** The agent's structured result, once it has one. */
  result?: unknown;
  /**
   * Hand a message to the agent.
   *
   * Returns how it landed: `delivered` when the agent is running and the
   * message reached it, `queued` when the agent cannot take it yet, and
   * `failed` when it never will. The caller needs the distinction — a queued
   * message is a reason to keep waiting; a failed one is not.
   */
  deliver(message: string): DeliveryReceipt;
  /** Whatever transcript the agent has produced so far. */
  transcript(): string;
}
export type AgentRegistryListener = () => void;

let nextAgentOrdinal = 0;
const agents = new Map<string, AgentHandle>();
const listeners = new Set<AgentRegistryListener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * The agents a caller may see: itself, its parent, anything it spawned, and
 * its siblings.
 *
 * Siblings matter. When work fans out across agents, the only way they avoid
 * colliding on the same files — or duplicating work another branch already
 * finished — is to message each other, and a visibility rule that hides
 * siblings would make that impossible.
 *
 * A grandchild of a sibling stays hidden: the tree does not open sideways
 * past one level, and an agent spawned by a stranger is invisible.
 */
export function listVisibleTo(callerId: string | undefined): AgentHandle[] {
  if (callerId === undefined) return [...agents.values()];
  const caller = agents.get(callerId);
  const callerPrefix = `${callerId}.`;
  const visible: AgentHandle[] = [];
  for (const [id, handle] of agents) {
    if (id === callerId || id.startsWith(callerPrefix)) {
      visible.push(handle);
      continue;
    }
    if (caller === undefined) continue;
    // The parent it was spawned by: reporting up is the whole point of a
    // subagent.
    if (handle.id === caller.parentId) {
      visible.push(handle);
      continue;
    }
    // A sibling shares that parent id.
    if (handle.parentId !== undefined && handle.parentId === caller.parentId) {
      visible.push(handle);
    }
  }
  return visible;
}
/**
 * Mint an id for a new agent.
 *
 * Ids nest with dots so a parent is addressable by prefix and a child is
 * obviously a child: `a3`, `a3.1`. The ordinal is process-global so two
 * concurrent spawns cannot collide.
 */
export function mintAgentId(parentId: string | undefined): string {
  nextAgentOrdinal++;
  return parentId === undefined
    ? `a${nextAgentOrdinal}`
    : `${parentId}.${nextAgentOrdinal}`;
}

export function registerAgent(handle: AgentHandle): void {
  agents.set(handle.id, handle);
  notify();
}

export function getAgent(id: string): AgentHandle | undefined {
  return agents.get(id);
}

export function listAgents(): AgentHandle[] {
  return [...agents.values()];
}

/** Mark an agent finished. Idempotent, so a double-settle is harmless. */
export function finishAgent(
  id: string,
  status: Extract<AgentStatus, 'done' | 'aborted'>,
  result?: unknown,
): void {
  const handle = agents.get(id);
  if (handle === undefined) return;
  // A handle whose status is neither done nor aborted is neither running nor
  // settled, so it is invisible to every filter over the registry and shows up
  // as a blank mark. Refuse rather than write a status nothing can read.
  if (status !== 'done' && status !== 'aborted') {
    throw new Error(
      `finishAgent(${id}) needs a settled status, got ${String(status)}`,
    );
  }
  handle.status = status;
  if (result !== undefined) handle.result = result;
  notify();
}

/** Drop settled agents, so a long session does not accumulate the roster. */
export function pruneSettledAgents(): number {
  let removed = 0;
  for (const [id, handle] of agents) {
    if (handle.status === 'done' || handle.status === 'aborted') {
      agents.delete(id);
      removed++;
    }
  }
  if (removed > 0) notify();
  return removed;
}

/** Reset the registry. Test-only; the process owns this in production. */
export function clearAgentRegistry(): void {
  agents.clear();
  nextAgentOrdinal = 0;
  notify();
}

export function onAgentRegistryChange(
  listener: AgentRegistryListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
