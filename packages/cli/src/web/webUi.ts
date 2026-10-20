/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import type { CommandContext } from '../ui/commands/types.js';
import type { ExtensionUpdateAction } from '../ui/state/extensions.js';
import type { ServerEvent, WebConfirmationRequest } from './protocol.js';

/**
 * Flattens the React node a command uses for its confirmation prompt into
 * plain text the browser can render.
 *
 * The terminal draws these with Ink; over the web we only have the text, so
 * anything that is not a string is described rather than dropped, so the user
 * still knows what they are agreeing to.
 */
export function promptToText(prompt: ReactNode): string {
  if (typeof prompt === 'string') {
    return prompt;
  }
  if (Array.isArray(prompt)) {
    return prompt.map(promptToText).filter(Boolean).join('\n');
  }
  if (prompt && typeof prompt === 'object' && 'props' in prompt) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const props = prompt.props as { children?: ReactNode } | undefined;
    if (props?.children !== undefined) {
      return promptToText(props.children);
    }
  }
  if (prompt === null || prompt === undefined || prompt === false) {
    return '';
  }
  return String(prompt);
}

/** Handles the confirmations the agent asks for while a command runs. */
export class WebConfirmationBroker {
  private nextId = 0;
  private readonly pending = new Map<string, (confirmed: boolean) => void>();

  constructor(private readonly send: (event: ServerEvent) => void) {}

  /** Asks the user and resolves once they answer. */
  request(
    title: string,
    prompt: ReactNode,
    options: string[] = ['Yes', 'No', 'Always allow'],
    callId?: string,
  ): Promise<boolean> {
    const id = `confirmation-${++this.nextId}`;
    const request: WebConfirmationRequest = {
      id,
      title,
      details: promptToText(prompt),
      options,
      callId,
    };
    return new Promise<boolean>((resolve) => {
      this.pending.set(id, (confirmed) => {
        this.send({ type: 'confirmation_resolved', id, confirmed });
        resolve(confirmed);
      });
      this.send({ type: 'confirmation_request', request });
    });
  }

  /** Delivers the browser's answer. Returns false when the id is unknown. */
  resolve(id: string, confirmed: boolean): boolean {
    const resolve = this.pending.get(id);
    if (!resolve) {
      return false;
    }
    this.pending.delete(id);
    resolve(confirmed);
    return true;
  }
}

/**
 * Builds a `CommandContext['ui']` that forwards what the user would see on
 * the terminal to the browser instead.
 *
 * The terminal UI drives these callbacks with Ink/React state updates. Over the
 * web the equivalent is a socket message, so `addItem` pushes an event and
 * `setConfirmationRequest` asks the user through the broker. The rest are
 * no-ops, exactly as in the non-interactive UI.
 */
export function createWebUI(
  send: (event: ServerEvent) => void,
  broker: WebConfirmationBroker,
): CommandContext['ui'] {
  return {
    history: [],
    addItem: (item, _timestamp) => {
      send({ type: 'history_item', item });
      return 0;
    },
    clear: () => {},
    setDebugMessage: (_message: string) => {},
    pendingItem: null,
    setPendingItem: (_item) => {},
    loadHistory: (_newHistory) => {},
    toggleCorgiMode: () => {},
    toggleDebugProfiler: () => {},
    toggleVimEnabled: async () => false,
    reloadCommands: () => {},
    openAgentConfigDialog: () => {},
    extensionsUpdateState: new Map(),
    dispatchExtensionStateUpdate: (_action: ExtensionUpdateAction) => {},
    addConfirmUpdateExtensionRequest: (request) => {
      void broker
        .request('Confirm extension update', request.prompt, ['Yes', 'No'])
        .then((confirmed) => request.onConfirm(confirmed));
    },
    setConfirmationRequest: (value) => {
      if (!value) {
        return;
      }
      void broker
        .request('Confirm', value.prompt, ['Yes', 'No', 'Always allow'])
        .then((confirmed) => value.onConfirm(confirmed));
    },
    removeComponent: () => {},
    toggleBackgroundTasks: () => {},
    toggleShortcutsHelp: () => {},
    toggleVoiceMode: () => {},
  };
}
