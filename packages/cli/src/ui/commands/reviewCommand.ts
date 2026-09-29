/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  collectReviewTarget,
  countChangedLines,
  getRecommendedReviewAgentCount,
} from '@google/gemini-cli-core';
import { CommandKind, type SlashCommand } from './types.js';

/**
 * `/review` — review the uncommitted diff with parallel subagents.
 *
 * Ported from omp's `/review`. A review is worth having when the diff is
 * bigger than one pair of eyes, and the fan-out is what makes it affordable:
 * several reviewers looking at disjoint slices, each returning findings the
 * parent can rank.
 *
 * The diff is FROZEN before the reviewers start. A review that re-runs git
 * while the agent is still editing describes a file that no longer exists, so
 * the prompt explicitly forbids it.
 *
 * The review is driven entirely through `invoke_agent`, which already exists
 * here. There is no bespoke orchestration: the model reads the diff, decides
 * how to slice it, and delegates.
 */
export const reviewCommand: SlashCommand = {
  name: 'review',
  description: 'Review the uncommitted changes with parallel subagents',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context, args) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No active session to review against.',
      };
    }

    const target = await collectReviewTarget(config.getTargetDir());
    if (target.error !== undefined) {
      return {
        type: 'message',
        messageType: 'error',
        content: target.error,
      };
    }

    const changedLines = countChangedLines(target.diff);
    const agents = getRecommendedReviewAgentCount(
      changedLines,
      target.files.length,
    );

    const instructions = [
      `Review the uncommitted changes in this repository (${target.source}).`,
      '',
      `Files changed: ${target.files.length}`,
      `Changed lines: ${changedLines}`,
      target.summarised
        ? 'The diff below is TRUNCATED to the first lines of each file. Review what is shown and say so where you could not see enough.'
        : '',
      '',
      '## Rules',
      '',
      '- Do NOT run git. The diff below is frozen; the working tree may change',
      '  while you review, and re-running git would make your findings describe a',
      '  file that no longer exists.',
      '- Only report problems this change INTRODUCES. Pre-existing issues are',
      '  out of scope unless this change makes them materially worse.',
      '- Every finding must name a file and a line, and must be actionable.',
      '- If you find nothing, say so. An empty finding list is a valid result.',
      '',
      '## How to delegate',
      '',
      `Invoke the \`generalist\` subagent ${agents} time(s) with a \`tasks\` array,`,
      'splitting the files above into disjoint groups. Give each subagent the',
      'complete diff section for its files and nothing else, so two reviewers',
      'never duplicate work.',
      '',
      'Ask each for findings of the form:',
      '',
      '```',
      '{',
      '  "findings": [',
      '    {',
      '      "title": "short statement of the defect",',
      '      "file_path": "src/foo.ts",',
      '      "line_start": 42,',
      '      "line_end": 44,',
      '      "priority": "P0 | P1 | P2 | P3",',
      '      "confidence": "high | medium | low",',
      '      "body": "what is wrong and why it matters"',
      '    }',
      '  ]',
      '}',
      '```',
      '',
      'P0 breaks the build or loses data. P1 is a real bug. P2 is a correctness',
      'or maintainability problem. P3 is a nit. Then rank the findings you',
      'collected by priority and summarise the top three.',
      '',
      '## Diff',
      '',
      '```diff',
      target.diff,
      '```',
      '',
      args !== undefined && args.trim() !== ''
        ? `## Extra focus from the user\n\n${args.trim()}`
        : '',
    ]
      .filter((line) => line !== '')
      .join('\n');

    return {
      type: 'submit_prompt',
      content: instructions,
    };
  },
};
