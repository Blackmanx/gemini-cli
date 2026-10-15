/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';

/**
 * `/archify` — drive the built-in archify skill from a slash command.
 *
 * Skill activation is normally the model's job: the system prompt lists
 * archify's name and description, and the model calls `activate_skill` on its
 * own when a request matches. This command exists for the other case — the
 * user who already knows what they want drawn and does not want the match to
 * be a judgement call. With no arguments it maps the current workspace:
 * `/archify` alone asks for an architecture diagram of the repository in the
 * working directory. Delivery is always flat into `.archify/`: a stable
 * mode-named HTML (`.archify/architecture.html`, …) that each passing run
 * overwrites, so the same path always serves the latest diagram and a failed
 * run leaves the previous one untouched.
 *
 * The command does not author the diagram itself. It submits a prompt that
 * forces activation first and passes the request through, so the model still
 * does the work under the skill's own contract (typed JSON candidate, then
 * `finalize` with its validation and browser gates).
 */
export const archifyCommand: SlashCommand = {
  name: 'archify',
  description:
    'Create a diagram with the archify skill. Usage: /archify [what to diagram; defaults to the current workspace]',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context, args) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No active session.',
      };
    }

    const skill = config.getSkillManager().getSkill('archify');
    if (!skill) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'The archify skill is not available. Reload discovered skills with /skills reload.',
      };
    }
    if (skill.disabled) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'The archify skill is disabled. Enable it with: /skills enable archify',
      };
    }

    const request = (args ?? '').trim();

    const prompt = [
      'Activate the built-in `archify` skill with the `activate_skill` tool',
      '(name: `archify`), then follow its instructions to create a diagram.',
      '',
      ...(request === ''
        ? [
            'The target is the CURRENT WORKSPACE — the repository in the',
            'working directory. Default to an `architecture` diagram of the',
            'codebase: its main components, how they connect, and the main',
            'user journey through them. Choose another mode (tree, dataflow,',
            'sequence, ...) only when the repository makes a different story',
            'clearly the more useful one.',
          ]
        : ['The requested diagram:', '', request]),
      '',
      'Rules:',
      '',
      '- Activate the skill FIRST and follow its SKILL.md workflow exactly:',
      '  author the typed JSON candidate, then run `finalize` from the skill',
      '  directory using the absolute path the activation returns.',
      '- Deliver flat into `.archify/` in the working directory: author the',
      '  candidate at `.archify/candidate.json` and let `finalize` write the',
      '  HTML directly to `.archify/<mode>.html` (e.g.',
      '  `.archify/architecture.html`). Do NOT create the skill default',
      '  `.archify/<type>-<slug>-<timestamp>/` folders or any other',
      '  subdirectory under `.archify/`.',
      '- The mode-named HTML is stable across runs: a passing `finalize`',
      '  overwrites it, so the same path always serves the latest diagram,',
      '  and a failing run leaves the previous file untouched so the last',
      '  good architecture remains there.',
      '- Ground every node and relationship in repository evidence; do not',
      '  invent structure the repository does not show.',
      '- If a `finalize` gate fails, follow the skill repair loop. A non-zero',
      '  exit is never success.',
      '- Finish by telling the user the final HTML path.',
    ].join('\n');

    return {
      type: 'submit_prompt',
      content: prompt,
    };
  },
};
