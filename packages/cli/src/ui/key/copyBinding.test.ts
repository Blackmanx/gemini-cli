/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createKeyMatchers,
  defaultKeyMatchers,
  Command,
} from './keyMatchers.js';
import { KeyBinding } from './keyBindings.js';
import type { Key } from '../hooks/useKeypress.js';

/**
 * The parser in KeypressContext turns a terminal byte sequence into the
 * `{name, shift, ctrl, cmd}` shape these matchers compare against. A binding
 * can therefore be unreachable no matter how it is spelled, and the only way
 * to know is to check it against what the parser actually produces.
 */
function parserOutput(sequence: string): Key {
  const code = sequence.charCodeAt(0);
  // A control character carries no shift information: a terminal sends the
  // same byte for Ctrl+C and Ctrl+Shift+C, so the parser can only report ctrl.
  if (sequence.length === 1 && code >= 1 && code <= 0x1a) {
    return {
      name: String.fromCharCode(code + 'a'.charCodeAt(0) - 1),
      shift: false,
      ctrl: true,
      cmd: false,
      alt: false,
      insertable: false,
      sequence,
    };
  }
  if (sequence === '\x1b[15~') {
    return {
      name: 'f5',
      shift: false,
      ctrl: false,
      cmd: false,
      alt: false,
      insertable: false,
      sequence,
    };
  }
  throw new Error(`unhandled sequence in test: ${JSON.stringify(sequence)}`);
}

describe('COPY_LAST_CODE_BLOCK binding', () => {
  it('is reachable through the sequence a terminal sends for F5', () => {
    expect(
      defaultKeyMatchers[Command.COPY_LAST_CODE_BLOCK](
        parserOutput('\x1b[15~'),
      ),
    ).toBe(true);
  });

  it('is unreachable through ctrl+shift+c, which no terminal can send', () => {
    // A binding spelled ctrl+shift+c is dead on arrival: \x03 is what both
    // Ctrl+C and Ctrl+Shift+C send, and the parser reports shift false. This
    // test exists because that binding shipped once and never fired.
    const matchers = createKeyMatchers(
      new Map([
        [Command.COPY_LAST_CODE_BLOCK, [new KeyBinding('ctrl+shift+c')]],
      ]),
    );

    expect(matchers[Command.COPY_LAST_CODE_BLOCK](parserOutput('\x03'))).toBe(
      false,
    );
    // The only state the parser can reach for \x03 is shift false, and that
    // is exactly what this binding refuses. A terminal cannot send the shift.
  });
});
