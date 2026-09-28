/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getAgent,
  listVisibleTo,
  type DeliveryReceipt,
} from './agentRegistry.js';

/**
 * Peer-to-peer messaging between agents.
 *
 * Ported from omp's `irc/`. There is no `irc` tool: a message is addressed as
 * `agent://<id>`, so the model learns one addressing scheme instead of two.
 * What this buys is real — without it, parallel agents can only either work
 * independently or collide, because neither can tell the other what it found.
 */

/** Oldest messages are dropped past this, so a stuck agent cannot grow without bound. */
export const PEER_MAILBOX_LIMIT = 100;

/** One delivered message. */
export interface PeerMessage {
  /** Stable id, so a reply can quote the message it answers. */
  id: string;
  from: string;
  to: string;
  body: string;
  at: number;
  /** The id this is a reply to, when it is one. */
  replyTo?: string;
}

interface Mailbox {
  messages: PeerMessage[];
  /** Agents currently blocked in `wait`, woken when a message lands. */
  waiting: Set<() => void>;
}

const mailboxes = new Map<string, Mailbox>();
const listeners = new Set<(message: PeerMessage) => void>();

function mailboxFor(id: string): Mailbox {
  const existing = mailboxes.get(id);
  if (existing !== undefined) return existing;
  const created: Mailbox = { messages: [], waiting: new Set() };
  mailboxes.set(id, created);
  return created;
}

let nextMessageOrdinal = 0;

/**
 * Deliver a message to one agent.
 *
 * `to` may be an id or `all`, which reaches every agent the sender can see
 * (its own subtree). A sender that is not registered has no visibility, so a
 * broadcast from it reaches nobody — that is the rule, not an oversight.
 */
export function sendPeerMessage(
  from: string,
  to: string,
  body: string,
  replyTo?: string,
): { delivered: number; receipts: DeliveryReceipt[] } {
  const sender = getAgent(from);
  const targets =
    to === 'all'
      ? listVisibleTo(sender === undefined ? undefined : from)
      : [getAgent(to)].filter((agent) => agent !== undefined);

  const receipts: DeliveryReceipt[] = [];
  let delivered = 0;
  for (const target of targets) {
    if (target === undefined || target.id === from) continue;
    const receipt = target.deliver(body);
    receipts.push(receipt);
    if (receipt !== 'failed') delivered++;
    nextMessageOrdinal++;
    const message: PeerMessage = {
      id: `m${nextMessageOrdinal}`,
      from,
      to: target.id,
      body,
      at: Date.now(),
    };
    if (replyTo !== undefined) message.replyTo = replyTo;
    const mailbox = mailboxFor(target.id);
    mailbox.messages.push(message);
    // Drop the oldest rather than the newest: the recent turn is the one the
    // agent is actually working from.
    if (mailbox.messages.length > PEER_MAILBOX_LIMIT) mailbox.messages.shift();
    for (const listener of listeners) listener(message);
    // A message that can end a wait must actually end it.
    for (const wake of [...mailbox.waiting]) wake();
  }
  return { delivered, receipts };
}

/** Everything waiting in an agent's mailbox, oldest first. */
export function takePeerMessages(id: string): PeerMessage[] {
  const mailbox = mailboxes.get(id);
  if (mailbox === undefined) return [];
  const messages = mailbox.messages;
  mailbox.messages = [];
  return messages;
}

/** How many unread messages an agent has. */
export function unreadPeerCount(id: string): number {
  return mailboxes.get(id)?.messages.length ?? 0;
}

/**
 * Run `fn` while registered as waiting, and resolve early when a message
 * arrives. Returns a function that tears the registration down, so a caller
 * that finished for another reason does not leave a stale wake installed.
 */
export function withPeerWake(
  id: string,
  fn: () => Promise<void>,
): { promise: Promise<void>; cancel: () => void } {
  const mailbox = mailboxFor(id);
  let cancelled = false;
  const wake = () => {
    if (!cancelled) void fn();
  };
  mailbox.waiting.add(wake);
  return {
    promise: fn(),
    cancel: () => {
      cancelled = true;
      mailbox.waiting.delete(wake);
    },
  };
}

/** Observe every delivered message. Used by the roster view. */
export function onPeerMessage(
  listener: (message: PeerMessage) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reset the bus. Test-only. */
export function clearPeerBus(): void {
  mailboxes.clear();
  listeners.clear();
  nextMessageOrdinal = 0;
}
