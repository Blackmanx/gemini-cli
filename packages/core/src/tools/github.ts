/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `github` tool: one confirmable entry point over the GitHub CLI for
 * repository, pull request, issue, search, and Actions-run operations.
 *
 * Every operation shells out through {@link GhService}, which is
 * non-interactive by construction. The tool itself owns three concerns:
 * the operation dispatch and its parameters, a compact human-readable
 * rendering of each result (never a raw JSON dump), and the confirmation
 * details — publishing a pull request or an issue is irreversible, so the
 * confirmation names the operation and shows exactly what will be published
 * before anything leaves the machine.
 *
 * Scope note: the CLI's PR worktree machinery and its SQLite cache are
 * deliberately not ported. Checkpointing, repository discovery, and worktree
 * management already live in `GitService` and `WorktreeService`; a second git
 * surface would be a second source of truth.
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolConfirmationOutcome,
  type ToolCallConfirmationDetails,
  type ToolExecuteConfirmationDetails,
  type ToolInvocation,
  type ToolResult,
  type ExecuteOptions,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { getErrorMessage } from '../utils/errors.js';
import { delay } from '../utils/delay.js';
import { tmpdir } from '../utils/paths.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import {
  GhService,
  GhError,
  GH_UNAVAILABLE_MESSAGE,
  type GhJsonValue,
} from '../services/ghService.js';

/** Operations this tool exposes. `op` selects the one that runs. */
export type GithubOp =
  | 'repo_view'
  | 'pr_list'
  | 'pr_view'
  | 'pr_create'
  | 'pr_checkout'
  | 'issue_list'
  | 'issue_view'
  | 'issue_create'
  | 'search_code'
  | 'search_issues'
  | 'run_watch';

/** Every documented operation, keyed by name for validation. */
export const GITHUB_OPS: Record<GithubOp, true> = {
  repo_view: true,
  pr_list: true,
  pr_view: true,
  pr_create: true,
  pr_checkout: true,
  issue_list: true,
  issue_view: true,
  issue_create: true,
  search_code: true,
  search_issues: true,
  run_watch: true,
};

export interface GithubParams {
  op: GithubOp;
  repo?: string;
  branch?: string;
  pr?: string | string[];
  issue?: string | string[];
  title?: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
  fill?: boolean;
  reviewer?: string[];
  assignee?: string[];
  label?: string[];
  state?: 'open' | 'closed' | 'merged' | 'all';
  limit?: number;
  query?: string;
  run?: string;
  tail?: number;
  force?: boolean;
  detach?: boolean;
  comments?: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_TAIL = 20;
const MAX_TAIL = 500;

/** Poll cadence, mirroring the upstream agent: fast early, then backed off. */
const RUN_WATCH_FAST_INTERVAL_MS = 3_000;
const RUN_WATCH_SLOW_INTERVAL_MS = 15_000;
const RUN_WATCH_FAST_WINDOW_MS = 60_000;
/** Hard ceiling so a stuck run can never hold a turn open indefinitely. */
const RUN_WATCH_MAX_DURATION_MS = 15 * 60_000;
/** A repo with Actions disabled never produces a run; stop waiting on one. */
const RUN_WATCH_NO_RUNS_GIVE_UP_MS = 90_000;

const GH_REPO_FIELDS = [
  'nameWithOwner',
  'description',
  'url',
  'defaultBranchRef',
  'homepageUrl',
  'forkCount',
  'isArchived',
  'isFork',
  'primaryLanguage',
  'repositoryTopics',
  'stargazerCount',
  'updatedAt',
  'viewerPermission',
  'visibility',
];

const GH_PR_LIST_FIELDS = [
  'number',
  'title',
  'state',
  'isDraft',
  'author',
  'headRefName',
  'baseRefName',
  'updatedAt',
  'url',
  'labels',
  'additions',
  'deletions',
  'changedFiles',
];

const GH_PR_VIEW_FIELDS = [
  ...GH_PR_LIST_FIELDS,
  'createdAt',
  'body',
  'mergeable',
  'mergeStateStatus',
  'reviewDecision',
  'headRefOid',
  'commits',
  'files',
  'reviews',
  'comments',
];

const GH_ISSUE_LIST_FIELDS = [
  'number',
  'title',
  'state',
  'author',
  'labels',
  'updatedAt',
  'url',
  'comments',
];

const GH_ISSUE_VIEW_FIELDS = [
  ...GH_ISSUE_LIST_FIELDS,
  'body',
  'createdAt',
  'stateReason',
];

const GH_RUN_FIELDS = [
  'databaseId',
  'name',
  'displayTitle',
  'status',
  'conclusion',
  'headBranch',
  'createdAt',
  'updatedAt',
  'url',
  'workflowName',
  'jobs',
];

export const GITHUB_TOOL_DESCRIPTION =
  'Work with GitHub repositories, pull requests, issues, code search, and Actions runs via the `gh` CLI. ' +
  'Read-only operations: repo_view, pr_list, pr_view, issue_list, issue_view, search_code, search_issues, run_watch. ' +
  'Publishing operations: pr_create, issue_create. Local operation: pr_checkout. ' +
  'Every call requires confirmation, so pass every argument you want applied — nothing is inferred from the conversation.';

export const GITHUB_PARAMETER_SCHEMA = {
  type: 'object',
  properties: {
    op: {
      type: 'string',
      enum: Object.keys(GITHUB_OPS),
      description: 'The GitHub operation to perform.',
    },
    repo: {
      type: 'string',
      description:
        'Target repository as owner/repo. Defaults to the repository at the workspace root.',
    },
    branch: {
      type: 'string',
      description:
        'Branch name. Used by repo_view and as the run_watch target.',
    },
    pr: {
      oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      description:
        'Pull request selector: number, URL, or branch name. An array selects several for pr_list.',
    },
    issue: {
      oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      description:
        'Issue selector: number or URL. An array selects several for issue_list.',
    },
    title: {
      type: 'string',
      description: 'Title for pr_create or issue_create.',
    },
    body: {
      type: 'string',
      description: 'Markdown body for pr_create or issue_create.',
    },
    base: { type: 'string', description: 'Base branch for pr_create.' },
    head: { type: 'string', description: 'Head branch for pr_create.' },
    draft: {
      type: 'boolean',
      description: 'Open the pull request as a draft.',
    },
    fill: {
      type: 'boolean',
      description:
        'Let gh derive title and body from the commits. Mutually exclusive with title and body.',
    },
    reviewer: {
      type: 'array',
      items: { type: 'string' },
      description: 'Reviewer logins for pr_create.',
    },
    assignee: {
      type: 'array',
      items: { type: 'string' },
      description: 'Assignee logins for pr_create or issue_create.',
    },
    label: {
      type: 'array',
      items: { type: 'string' },
      description: 'Labels for pr_create or issue_create.',
    },
    state: {
      type: 'string',
      enum: ['open', 'closed', 'merged', 'all'],
      description: 'State filter for list operations. Defaults to open.',
    },
    limit: {
      type: 'number',
      description: `Maximum results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
    },
    query: {
      type: 'string',
      description: 'Search query for search_code or search_issues.',
    },
    run: {
      type: 'string',
      description:
        'Actions run to watch: numeric run ID or full run URL. Defaults to the newest run on `branch`.',
    },
    tail: {
      type: 'number',
      description: `Log lines to show per failed job in run_watch (default ${DEFAULT_TAIL}, max ${MAX_TAIL}).`,
    },
    force: {
      type: 'boolean',
      description: 'Reset an existing local branch to the pull request head.',
    },
    detach: {
      type: 'boolean',
      description: 'Check out the pull request with a detached HEAD.',
    },
    comments: {
      type: 'boolean',
      description: 'Include comments, reviews, and files in view operations.',
    },
  },
  required: ['op'],
} as const;

const PR_URL_PATTERN =
  /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/;
const ISSUE_URL_PATTERN =
  /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/.*)?$/;
const RUN_URL_PATTERN =
  /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/.*)?$/;

// ---------------------------------------------------------------------------
// Payload shapes
//
// These are `type` aliases rather than `interface`s so each one is assignable
// to the index-signature form `GhService.json` bounds its generic by.
// ---------------------------------------------------------------------------

type GhUser = { login?: string };
type GhLabel = { name?: string };
type GhComment = { author?: GhUser; body?: string; createdAt?: string };
type GhReview = {
  author?: GhUser;
  state?: string;
  body?: string;
  submittedAt?: string;
};
type GhFile = { path?: string; additions?: number; deletions?: number };
type GhCommit = { oid?: string; messageHeadline?: string };

type GhRepoViewData = {
  nameWithOwner?: string;
  description?: string;
  url?: string;
  defaultBranchRef?: { name?: string };
  homepageUrl?: string;
  forkCount?: number;
  isArchived?: boolean;
  isFork?: boolean;
  primaryLanguage?: { name?: string };
  repositoryTopics?: Array<{ topic?: { name?: string } }>;
  stargazerCount?: number;
  updatedAt?: string;
  viewerPermission?: string;
  visibility?: string;
};

type GhPrListItem = {
  number?: number;
  title?: string;
  state?: string;
  isDraft?: boolean;
  author?: GhUser;
  headRefName?: string;
  baseRefName?: string;
  updatedAt?: string;
  url?: string;
  labels?: GhLabel[];
  additions?: number;
  deletions?: number;
  changedFiles?: number;
};

type GhPrViewData = GhPrListItem & {
  createdAt?: string;
  body?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  headRefOid?: string;
  commits?: GhCommit[];
  files?: GhFile[];
  reviews?: GhReview[];
  comments?: GhComment[];
};

type GhIssueListItem = {
  number?: number;
  title?: string;
  state?: string;
  author?: GhUser;
  labels?: GhLabel[];
  updatedAt?: string;
  url?: string;
  comments?: Array<{ totalCount?: number }>;
};

type GhIssueViewData = GhIssueListItem & {
  body?: string;
  createdAt?: string;
  stateReason?: string;
};

type GhSearchCodeItem = {
  path?: string;
  url?: string;
  repository?: { nameWithOwner?: string };
};

type GhSearchIssueItem = {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  updatedAt?: string;
  author?: GhUser;
  repository?: { nameWithOwner?: string };
};

type GhRunJob = {
  databaseId?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  startedAt?: string;
  completedAt?: string;
};

type GhRunData = {
  databaseId?: number;
  name?: string;
  displayTitle?: string;
  status?: string;
  conclusion?: string | null;
  headBranch?: string;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  workflowName?: string;
  jobs?: GhRunJob[];
};

const RUN_FAILURE_CONCLUSIONS: Record<string, true> = {
  failure: true,
  timed_out: true,
  cancelled: true,
  action_required: true,
  startup_failure: true,
};

const RUN_SUCCESS_CONCLUSIONS: Record<string, true> = {
  success: true,
  neutral: true,
  skipped: true,
};

type RunOutcome = 'success' | 'failure' | 'pending';

function isFailedJob(job: GhRunJob): boolean {
  const conclusion = job.conclusion;
  return (
    conclusion !== undefined &&
    conclusion !== null &&
    RUN_FAILURE_CONCLUSIONS[conclusion] === true
  );
}

function runOutcome(run: GhRunData): RunOutcome {
  const conclusion = run.conclusion;
  if (run.status !== 'completed' || !conclusion) {
    return 'pending';
  }
  if (RUN_SUCCESS_CONCLUSIONS[conclusion] === true) {
    return 'success';
  }
  if (RUN_FAILURE_CONCLUSIONS[conclusion] === true) {
    return 'failure';
  }
  return 'pending';
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

function normalizeText(value: string | undefined | null): string {
  return (value ?? '')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\t', '    ')
    .trim();
}

function pushLine(
  lines: string[],
  label: string,
  value?: string | number | boolean | null,
): void {
  if (value === undefined || value === null || value === '') {
    return;
  }
  lines.push(`${label}: ${value}`);
}

function formatLabels(labels: GhLabel[] | undefined): string | undefined {
  const names = (labels ?? [])
    .map((label) => normalizeText(label.name))
    .filter((name) => name.length > 0);
  return names.length > 0 ? names.join(', ') : undefined;
}

function formatAuthor(author: GhUser | undefined): string | undefined {
  return normalizeText(author?.login) || undefined;
}

function formatShortSha(sha: string | undefined): string {
  const value = normalizeText(sha);
  return value.length > 7 ? value.slice(0, 7) : value;
}

function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function clampLimit(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}

/** Renders an argv for the confirmation prompt, quoting only what needs it. */
function renderCommand(args: readonly string[]): string {
  return args
    .map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg))
    .join(' ');
}

function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}… (${value.length - maxChars} more characters)`;
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

class GithubToolInvocation extends BaseToolInvocation<
  GithubParams,
  ToolResult
> {
  private readonly gh = new GhService();

  constructor(
    private readonly context: AgentLoopContext,
    params: GithubParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
      undefined,
      undefined,
      false,
      () => this.context.config.getApprovalMode(),
    );
  }

  getDescription(): string {
    const repo = this.params.repo ? ` on ${this.params.repo}` : '';
    return `${this.params.op}${repo}`;
  }

  /**
   * Every call confirms, and the publishing calls confirm differently: the
   * prompt shows the exact `gh` argv and, for the two create operations, the
   * title and body that will be published, so the user can judge the content
   * before it becomes public.
   */
  protected override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const op = this.params.op;
    const isPublishing = op === 'pr_create' || op === 'issue_create';
    const args = this.buildConfirmationArgs(op);
    const title = isPublishing
      ? op === 'pr_create'
        ? 'Confirm: Open GitHub Pull Request'
        : 'Confirm: Open GitHub Issue'
      : `Confirm: GitHub ${op}`;

    const details: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title,
      systemMessage: this.buildPublishPreview(),
      command: `gh ${renderCommand(args)}`,
      rootCommand: 'gh',
      rootCommands: ['gh'],
      onConfirm: async (_outcome: ToolConfirmationOutcome) => {
        // Policy updates are handled centrally by the scheduler.
      },
    };
    return details;
  }

  /**
   * The `gh` argv this call will run, used only for the confirmation prompt so
   * the user sees the literal command rather than a paraphrase.
   */
  private buildConfirmationArgs(op: GithubOp): string[] {
    const p = this.params;
    const repo = p.repo ? ['--repo', p.repo] : [];
    switch (op) {
      case 'repo_view':
        return [
          'repo',
          'view',
          ...(p.repo ? [p.repo] : []),
          '--json',
          GH_REPO_FIELDS.join(','),
        ];
      case 'pr_list':
        return ['pr', 'list', ...repo, '--json', GH_PR_LIST_FIELDS.join(',')];
      case 'pr_view':
        return [
          'pr',
          'view',
          toList(p.pr)[0] ?? '',
          ...repo,
          '--json',
          GH_PR_VIEW_FIELDS.join(','),
        ];
      case 'pr_create':
        // The body arrives via a temp file at run time; name it here so the
        // prompt shows where the text the user is shown above will come from.
        return [
          ...this.buildPrCreateArgs(),
          ...(p.fill ? [] : ['--body-file', '<body markdown>']),
        ];
      case 'pr_checkout':
        return ['pr', 'checkout', toList(p.pr)[0] ?? '', ...repo];
      case 'issue_list':
        return [
          'issue',
          'list',
          ...repo,
          '--json',
          GH_ISSUE_LIST_FIELDS.join(','),
        ];
      case 'issue_view':
        return [
          'issue',
          'view',
          toList(p.issue)[0] ?? '',
          ...repo,
          '--json',
          GH_ISSUE_VIEW_FIELDS.join(','),
        ];
      case 'issue_create':
        return [
          ...this.buildIssueCreateArgs(),
          '--body-file',
          '<body markdown>',
        ];
      case 'search_code':
        return ['search', 'code', p.query ?? '', ...repo];
      case 'search_issues':
        return ['search', 'issues', p.query ?? '', ...repo];
      case 'run_watch':
        return ['run', 'view', p.run ?? p.branch ?? '', ...repo];
      default:
        return ['--help'];
    }
  }

  /**
   * For the create operations, the literal text that will be published.
   * Returns `undefined` for every other operation so the prompt stays short.
   */
  private buildPublishPreview(): string | undefined {
    const p = this.params;
    if (p.op !== 'pr_create' && p.op !== 'issue_create') {
      return undefined;
    }
    const kind = p.op === 'pr_create' ? 'Pull request' : 'Issue';
    const lines = [
      `The following ${kind.toLowerCase()} will be published to ${p.repo ?? 'the current repository'}:`,
      '',
      `Title: ${p.title ?? '(derived from commits)'}`,
    ];
    if (p.base || p.head) {
      lines.push(
        `Branches: ${p.head ?? '(current)'} → ${p.base ?? '(default)'}`,
      );
    }
    if (p.draft) {
      lines.push('Opened as a draft.');
    }
    const labels = toList(p.label);
    if (labels.length > 0) {
      lines.push(`Labels: ${labels.join(', ')}`);
    }
    const reviewers = toList(p.reviewer);
    if (reviewers.length > 0) {
      lines.push(`Reviewers: ${reviewers.join(', ')}`);
    }
    const assignees = toList(p.assignee);
    if (assignees.length > 0) {
      lines.push(`Assignees: ${assignees.join(', ')}`);
    }
    if (p.body) {
      lines.push('', 'Body:', truncateForPrompt(p.body, 2000));
    } else {
      lines.push('', 'Body: (empty)');
    }
    return lines.join('\n');
  }

  async execute(options: ExecuteOptions): Promise<ToolResult> {
    const signal = options.abortSignal;
    const cwd = this.context.config.getTargetDir();

    const available = await this.gh.isAvailable(cwd);
    if (!available) {
      return this.failure(GH_UNAVAILABLE_MESSAGE, ToolErrorType.UNKNOWN);
    }

    try {
      return await this.dispatch(signal, cwd, (text) =>
        options.updateOutput?.(text),
      );
    } catch (error) {
      if (error instanceof GhError) {
        if (error.kind === 'unavailable' || error.kind === 'aborted') {
          return this.failure(
            error.kind === 'unavailable'
              ? GH_UNAVAILABLE_MESSAGE
              : error.message,
            ToolErrorType.UNKNOWN,
          );
        }
        return this.failure(error.message, ToolErrorType.EXECUTION_FAILED);
      }
      return this.failure(
        getErrorMessage(error),
        ToolErrorType.EXECUTION_FAILED,
      );
    }
  }

  private failure(message: string, type: ToolErrorType): ToolResult {
    return {
      llmContent: `Error: ${message}`,
      returnDisplay: message,
      error: { message, type },
    };
  }

  private success(text: string, url?: string): ToolResult {
    const display = url ? `${text}\n\nURL: ${url}` : text;
    return {
      llmContent: display,
      returnDisplay: display,
    };
  }

  private async dispatch(
    signal: AbortSignal,
    cwd: string,
    updateOutput: (text: string) => void,
  ): Promise<ToolResult> {
    switch (this.params.op) {
      case 'repo_view':
        return this.repoView(cwd, signal);
      case 'pr_list':
        return this.prList(cwd, signal);
      case 'pr_view':
        return this.prView(cwd, signal);
      case 'pr_create':
        return this.prCreate(cwd, signal);
      case 'pr_checkout':
        return this.prCheckout(cwd, signal);
      case 'issue_list':
        return this.issueList(cwd, signal);
      case 'issue_view':
        return this.issueView(cwd, signal);
      case 'issue_create':
        return this.issueCreate(cwd, signal);
      case 'search_code':
        return this.searchCode(cwd, signal);
      case 'search_issues':
        return this.searchIssues(cwd, signal);
      case 'run_watch':
        return this.runWatch(updateOutput, cwd, signal);
      default:
        throw new GhError(
          'command_failed',
          `Unsupported github operation: ${String(this.params.op)}`,
        );
    }
  }

  // -- repository ----------------------------------------------------------

  private async repoView(
    cwd: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const p = this.params;
    const args = ['repo', 'view'];
    if (p.repo) {
      args.push(p.repo);
    }
    args.push('--json', GH_REPO_FIELDS.join(','));
    const data = await this.gh.json<GhRepoViewData & GhJsonValue>(args, {
      cwd,
      signal,
    });

    const lines: string[] = [
      `# ${data.nameWithOwner ?? p.repo ?? 'Repository'}`,
      '',
    ];
    lines.push(normalizeText(data.description) || 'No description provided.');
    lines.push('');
    pushLine(lines, 'URL', data.url);
    pushLine(lines, 'Default branch', data.defaultBranchRef?.name);
    pushLine(lines, 'Branch', p.branch);
    pushLine(lines, 'Visibility', data.visibility);
    pushLine(lines, 'Your permission', data.viewerPermission);
    pushLine(lines, 'Primary language', data.primaryLanguage?.name);
    pushLine(lines, 'Stars', data.stargazerCount);
    pushLine(lines, 'Forks', data.forkCount);
    pushLine(lines, 'Archived', data.isArchived);
    pushLine(lines, 'Fork', data.isFork);
    pushLine(lines, 'Updated', data.updatedAt);
    pushLine(lines, 'Homepage', data.homepageUrl);
    const topics = (data.repositoryTopics ?? [])
      .map((entry) => normalizeText(entry.topic?.name))
      .filter((name) => name.length > 0)
      .join(', ');
    pushLine(lines, 'Topics', topics || undefined);
    return this.success(lines.join('\n').trim());
  }

  // -- pull requests -------------------------------------------------------

  private async prList(cwd: string, signal: AbortSignal): Promise<ToolResult> {
    const p = this.params;
    const limit = clampLimit(p.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const selectors = toList(p.pr);
    const args = ['pr', 'list'];
    if (p.repo) {
      args.push('--repo', p.repo);
    }
    if (p.state) {
      args.push('--state', p.state);
    }
    args.push('--limit', String(limit));
    if (selectors.length > 0) {
      args.push('--search', selectors.join(' '));
    }
    args.push('--json', GH_PR_LIST_FIELDS.join(','));

    const data = await this.gh.json<Array<GhPrListItem & GhJsonValue>>(args, {
      cwd,
      signal,
    });

    const scope = p.repo ? ` in ${p.repo}` : '';
    if (data.length === 0) {
      return this.success(`No pull requests found${scope}.`);
    }
    const lines = [`# Pull requests (${data.length})${scope}`, ''];
    for (const pr of data) {
      const draft = pr.isDraft ? ' [draft]' : '';
      const author = formatAuthor(pr.author);
      pushLine(
        lines,
        `## #${pr.number ?? '?'}${draft}`,
        pr.title ?? 'Untitled',
      );
      pushLine(lines, 'State', pr.state);
      pushLine(lines, 'Author', author);
      pushLine(
        lines,
        'Branches',
        `${pr.headRefName ?? '?'} → ${pr.baseRefName ?? '?'}`,
      );
      pushLine(lines, 'Labels', formatLabels(pr.labels));
      if (pr.changedFiles !== undefined) {
        pushLine(
          lines,
          'Diff',
          `${pr.changedFiles} files, +${pr.additions ?? 0}/-${pr.deletions ?? 0}`,
        );
      }
      pushLine(lines, 'Updated', pr.updatedAt);
      pushLine(lines, 'URL', pr.url);
      lines.push('');
    }
    return this.success(lines.join('\n').trim());
  }

  private async prView(cwd: string, signal: AbortSignal): Promise<ToolResult> {
    const p = this.params;
    const selector = toList(p.pr)[0];
    if (!selector) {
      throw new GhError('command_failed', 'pr_view requires `pr`.');
    }
    const args = ['pr', 'view', selector];
    if (p.repo) {
      args.push('--repo', p.repo);
    }
    const includeComments = p.comments !== false;
    args.push(
      '--json',
      includeComments
        ? GH_PR_VIEW_FIELDS.join(',')
        : GH_PR_LIST_FIELDS.join(','),
    );
    const data = await this.gh.json<GhPrViewData & GhJsonValue>(args, {
      cwd,
      signal,
    });

    const lines: string[] = [
      `# Pull Request #${data.number ?? selector}: ${data.title ?? 'Untitled'}`,
      '',
    ];
    pushLine(lines, 'State', data.state);
    pushLine(lines, 'Draft', data.isDraft);
    pushLine(lines, 'Author', formatAuthor(data.author));
    pushLine(lines, 'Base', data.baseRefName);
    pushLine(lines, 'Head', data.headRefName);
    pushLine(
      lines,
      'Head commit',
      formatShortSha(data.headRefOid) || undefined,
    );
    pushLine(lines, 'Review decision', data.reviewDecision);
    pushLine(
      lines,
      'Merge state',
      `${data.mergeable ?? 'UNKNOWN'} / ${data.mergeStateStatus ?? 'UNKNOWN'}`,
    );
    pushLine(lines, 'Created', data.createdAt);
    pushLine(lines, 'Updated', data.updatedAt);
    pushLine(lines, 'Labels', formatLabels(data.labels));
    pushLine(lines, 'URL', data.url);
    lines.push('', '## Body', '');
    lines.push(normalizeText(data.body) || 'No description provided.');

    const commits = data.commits ?? [];
    if (commits.length > 0) {
      lines.push('', `## Commits (${commits.length})`, '');
      for (const commit of commits) {
        lines.push(
          `- ${formatShortSha(commit.oid)} ${normalizeText(commit.messageHeadline)}`,
        );
      }
    }

    const files = data.files ?? [];
    if (files.length > 0) {
      lines.push('', `## Files (${files.length})`, '');
      for (const file of files.slice(0, DEFAULT_LIMIT)) {
        lines.push(
          `- ${file.path ?? '(unknown)'} (+${file.additions ?? 0}/-${file.deletions ?? 0})`,
        );
      }
      if (files.length > DEFAULT_LIMIT) {
        lines.push(`- …${files.length - DEFAULT_LIMIT} more files not shown`);
      }
    }

    if (includeComments) {
      const reviews = data.reviews ?? [];
      if (reviews.length > 0) {
        lines.push('', `## Reviews (${reviews.length})`, '');
        for (const review of reviews) {
          lines.push(
            `### ${formatAuthor(review.author) ?? 'unknown'} [${review.state ?? 'UNKNOWN'}]${review.submittedAt ? ` · ${review.submittedAt}` : ''}`,
          );
          lines.push('', normalizeText(review.body) || 'No review body.', '');
        }
      }
      const comments = data.comments ?? [];
      if (comments.length > 0) {
        lines.push('', `## Comments (${comments.length})`, '');
        for (const comment of comments) {
          lines.push(
            `### ${formatAuthor(comment.author) ?? 'unknown'}${comment.createdAt ? ` · ${comment.createdAt}` : ''}`,
          );
          lines.push('', normalizeText(comment.body) || 'No comment body.', '');
        }
      }
    }

    return this.success(lines.join('\n').trim());
  }

  private async prCreate(
    cwd: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const p = this.params;
    const args = this.buildPrCreateArgs();

    let output: string;
    if (p.fill) {
      output = await this.runGh(args, cwd, signal, 'pr create');
    } else {
      output = await this.withBodyFile(p.body, (bodyArg) =>
        this.runGh([...args, ...bodyArg], cwd, signal, 'pr create'),
      );
    }

    const createdUrl = this.extractUrl(output);
    const number = PR_URL_PATTERN.exec(createdUrl)?.[3];
    const lines = [
      `# Opened Pull Request${number ? ` #${number}` : ''}: ${normalizeText(p.title) || '(title derived from commits)'}`,
      '',
    ];
    pushLine(lines, 'URL', createdUrl);
    pushLine(lines, 'Base', p.base);
    pushLine(lines, 'Head', p.head);
    pushLine(lines, 'Draft', p.draft);
    if (number && p.repo) {
      const view = await this.gh
        .json<
          GhPrViewData & GhJsonValue
        >(['pr', 'view', number, '--repo', p.repo, '--json', GH_PR_LIST_FIELDS.join(',')], { cwd, signal })
        .catch(() => undefined);
      if (view) {
        pushLine(lines, 'State', view.state);
        pushLine(lines, 'Files changed', view.changedFiles);
      }
    }
    return this.success(lines.join('\n').trim());
  }

  /**
   * `gh pr create` argv. Shared with the confirmation prompt so the command
   * the user approves is literally the command that runs.
   */
  private buildPrCreateArgs(): string[] {
    const p = this.params;
    const title = normalizeText(p.title);
    if (!p.fill && !title) {
      throw new GhError(
        'command_failed',
        'pr_create requires `title`, or `fill: true` to derive it from the commits.',
      );
    }
    if (p.fill && (title || p.body !== undefined)) {
      throw new GhError(
        'command_failed',
        'pr_create: `fill` cannot be combined with `title` or `body`.',
      );
    }

    const args = ['pr', 'create'];
    if (p.repo) {
      args.push('--repo', p.repo);
    }
    if (title) {
      args.push('--title', title);
    }
    if (p.base) {
      args.push('--base', p.base);
    }
    if (p.head) {
      args.push('--head', p.head);
    }
    if (p.draft) {
      args.push('--draft');
    }
    if (p.fill) {
      args.push('--fill');
    }
    for (const reviewer of toList(p.reviewer)) {
      args.push('--reviewer', reviewer);
    }
    for (const assignee of toList(p.assignee)) {
      args.push('--assignee', assignee);
    }
    for (const label of toList(p.label)) {
      args.push('--label', label);
    }
    return args;
  }

  /**
   * Runs `gh` and returns stdout, turning a non-zero exit into a typed error
   * that carries `gh`'s own message rather than a bare exit code.
   */
  private async runGh(
    args: string[],
    cwd: string,
    signal: AbortSignal,
    what: string,
  ): Promise<string> {
    const result = await this.gh.run(args, { cwd, signal });
    if (result.exitCode !== 0) {
      throw new GhError(
        'command_failed',
        (result.stderr || result.stdout).trim() ||
          `${what} failed with exit code ${result.exitCode}.`,
        result.exitCode,
      );
    }
    return result.stdout;
  }

  /**
   * Supplies the body to a `create` invocation. A markdown body is written to
   * a temp file rather than passed on argv, which keeps a multi-KB body clear
   * of length limits and quoting hazards; an absent body becomes an explicit
   * empty one so `gh` never falls through to its (disabled) interactive
   * editor.
   */
  private async withBodyFile(
    body: string | undefined,
    runWithBody: (bodyArg: string[]) => Promise<string>,
  ): Promise<string> {
    if (!normalizeText(body)) {
      return runWithBody(['--body', '']);
    }
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'gh-body-'));
    try {
      const file = path.join(dir, 'body.md');
      await fs.writeFile(file, body ?? '', 'utf8');
      return await runWithBody(['--body-file', file]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  private async prCheckout(
    cwd: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const p = this.params;
    const selector = toList(p.pr)[0];
    if (!selector) {
      throw new GhError('command_failed', 'pr_checkout requires `pr`.');
    }
    const args = ['pr', 'checkout', selector];
    if (p.repo) {
      args.push('--repo', p.repo);
    }
    if (p.branch) {
      args.push('--branch', p.branch);
    }
    if (p.force) {
      args.push('--force');
    }
    if (p.detach) {
      args.push('--detach');
    }
    await this.runGh(args, cwd, signal, 'pr checkout');
    const branch = p.branch ?? p.head ?? 'the pull request head branch';
    return this.success(
      [
        '# Checked out pull request',
        '',
        `Selector: ${selector}`,
        `Local branch: ${branch}`,
        p.detach ? 'Detached HEAD.' : undefined,
        p.force
          ? 'Existing branch was reset to the pull request head.'
          : undefined,
      ]
        .filter((line) => line !== undefined)
        .join('\n')
        .trim(),
    );
  }

  // -- issues --------------------------------------------------------------

  private async issueList(
    cwd: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const p = this.params;
    const limit = clampLimit(p.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const selectors = toList(p.issue);
    const args = ['issue', 'list'];
    if (p.repo) {
      args.push('--repo', p.repo);
    }
    if (p.state && p.state !== 'merged') {
      args.push('--state', p.state);
    }
    if (selectors.length > 0) {
      args.push('--search', selectors.join(' '));
    }
    args.push('--limit', String(limit));
    args.push('--json', GH_ISSUE_LIST_FIELDS.join(','));

    const data = await this.gh.json<Array<GhIssueListItem & GhJsonValue>>(
      args,
      {
        cwd,
        signal,
      },
    );
    const scope = p.repo ? ` in ${p.repo}` : '';
    if (data.length === 0) {
      return this.success(`No issues found${scope}.`);
    }
    const lines = [`# Issues (${data.length})${scope}`, ''];
    for (const issue of data) {
      const total = issue.comments?.[0]?.totalCount ?? 0;
      lines.push(`## #${issue.number ?? '?'}: ${issue.title ?? 'Untitled'}`);
      pushLine(lines, 'State', issue.state);
      pushLine(lines, 'Author', formatAuthor(issue.author));
      pushLine(lines, 'Labels', formatLabels(issue.labels));
      pushLine(lines, 'Comments', total > 0 ? total : undefined);
      pushLine(lines, 'Updated', issue.updatedAt);
      pushLine(lines, 'URL', issue.url);
      lines.push('');
    }
    return this.success(lines.join('\n').trim());
  }

  private async issueView(
    cwd: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const p = this.params;
    const selector = toList(p.issue)[0];
    if (!selector) {
      throw new GhError('command_failed', 'issue_view requires `issue`.');
    }
    const includeComments = p.comments !== false;
    const args = ['issue', 'view', selector];
    if (p.repo) {
      args.push('--repo', p.repo);
    }
    args.push(
      '--json',
      includeComments
        ? GH_ISSUE_VIEW_FIELDS.join(',')
        : GH_ISSUE_LIST_FIELDS.join(','),
    );
    const data = await this.gh.json<GhIssueViewData & GhJsonValue>(args, {
      cwd,
      signal,
    });

    const lines: string[] = [
      `# Issue #${data.number ?? selector}: ${data.title ?? 'Untitled'}`,
      '',
    ];
    pushLine(lines, 'State', data.state);
    pushLine(lines, 'State reason', data.stateReason);
    pushLine(lines, 'Author', formatAuthor(data.author));
    pushLine(lines, 'Created', data.createdAt);
    pushLine(lines, 'Updated', data.updatedAt);
    pushLine(lines, 'Labels', formatLabels(data.labels));
    pushLine(lines, 'URL', data.url);
    lines.push('', '## Body', '');
    lines.push(normalizeText(data.body) || 'No description provided.');

    if (includeComments) {
      const comments = (data.comments ?? []) as Array<
        GhComment & { totalCount?: number }
      >;
      const rendered = comments.filter((comment) => comment.body !== undefined);
      if (rendered.length > 0) {
        lines.push(
          '',
          `## Comments (${comments[0]?.totalCount ?? rendered.length})`,
          '',
        );
        for (const comment of rendered) {
          lines.push(
            `### ${formatAuthor(comment.author) ?? 'unknown'}${comment.createdAt ? ` · ${comment.createdAt}` : ''}`,
          );
          lines.push('', normalizeText(comment.body) || 'No comment body.', '');
        }
      }
    }
    return this.success(lines.join('\n').trim());
  }

  private async issueCreate(
    cwd: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const args = this.buildIssueCreateArgs();
    const output = await this.withBodyFile(this.params.body, (bodyArg) =>
      this.runGh([...args, ...bodyArg], cwd, signal, 'issue create'),
    );
    const url = this.extractUrl(output);
    const number = ISSUE_URL_PATTERN.exec(url)?.[3];
    return this.success(
      [
        `# Opened Issue${number ? ` #${number}` : ''}: ${normalizeText(this.params.title)}`,
        '',
      ].join('\n'),
      url,
    );
  }

  /**
   * `gh issue create` argv. Shared with the confirmation prompt so the command
   * the user approves is literally the command that runs.
   */
  private buildIssueCreateArgs(): string[] {
    const p = this.params;
    const title = normalizeText(p.title);
    if (!title) {
      throw new GhError('command_failed', 'issue_create requires `title`.');
    }
    const args = ['issue', 'create', '--title', title];
    if (p.repo) {
      args.push('--repo', p.repo);
    }
    for (const assignee of toList(p.assignee)) {
      args.push('--assignee', assignee);
    }
    for (const label of toList(p.label)) {
      args.push('--label', label);
    }
    return args;
  }

  // -- search --------------------------------------------------------------

  private async searchCode(
    cwd: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const p = this.params;
    const query = normalizeText(p.query);
    if (!query) {
      throw new GhError('command_failed', 'search_code requires `query`.');
    }
    const limit = clampLimit(p.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const args = ['search', 'code', query, '--limit', String(limit)];
    if (p.repo) {
      args.push('--repo', p.repo);
    }
    args.push('--json', 'path,repository,url');
    const data = await this.gh.json<Array<GhSearchCodeItem & GhJsonValue>>(
      args,
      {
        cwd,
        signal,
      },
    );
    if (data.length === 0) {
      return this.success(`No code matches for \`${p.query}\`.`);
    }
    const lines = [`# Code results for \`${p.query}\` (${data.length})`, ''];
    for (const item of data) {
      const repo = item.repository?.nameWithOwner ?? p.repo ?? '';
      lines.push(`- ${repo ? `${repo}/` : ''}${item.path ?? '(unknown path)'}`);
      if (item.url) {
        lines.push(`  ${item.url}`);
      }
    }
    return this.success(lines.join('\n').trim());
  }

  private async searchIssues(
    cwd: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const p = this.params;
    const query = normalizeText(p.query);
    if (!query) {
      throw new GhError('command_failed', 'search_issues requires `query`.');
    }
    const limit = clampLimit(p.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const args = ['search', 'issues', query, '--limit', String(limit)];
    if (p.repo) {
      args.push('--repo', p.repo);
    }
    if (p.state) {
      args.push('--state', p.state);
    }
    args.push('--json', 'number,title,state,url,repository,updatedAt,author');
    const data = await this.gh.json<Array<GhSearchIssueItem & GhJsonValue>>(
      args,
      {
        cwd,
        signal,
      },
    );
    if (data.length === 0) {
      return this.success(`No issues match \`${p.query}\`.`);
    }
    const lines = [`# Issue results for \`${p.query}\` (${data.length})`, ''];
    for (const item of data) {
      const repo = item.repository?.nameWithOwner;
      lines.push(`## #${item.number ?? '?'}: ${item.title ?? 'Untitled'}`);
      pushLine(lines, 'State', item.state);
      pushLine(lines, 'Repository', repo);
      pushLine(lines, 'Author', formatAuthor(item.author));
      pushLine(lines, 'Updated', item.updatedAt);
      pushLine(lines, 'URL', item.url);
      lines.push('');
    }
    return this.success(lines.join('\n').trim());
  }

  // -- Actions -------------------------------------------------------------

  /**
   * Poll one Actions run to completion, reporting each observation through
   * `updateOutput` so the turn shows progress instead of blocking silently.
   * Bounded three ways: a wall-clock ceiling, a fast-then-slow cadence, and an
   * early give-up when the target commit produces no runs at all (a repo with
   * Actions disabled would otherwise poll forever).
   */
  private async runWatch(
    updateOutput: ((text: string) => void) | undefined,
    cwd: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const p = this.params;
    const tail = clampLimit(p.tail, DEFAULT_TAIL, MAX_TAIL);
    const startedAt = Date.now();

    let runId: string | undefined;
    let repo = p.repo;
    const urlMatch = p.run ? RUN_URL_PATTERN.exec(p.run) : null;
    if (p.run) {
      if (urlMatch) {
        runId = urlMatch[3];
        repo = repo ?? `${urlMatch[1]}/${urlMatch[2]}`;
      } else if (/^\d+$/.test(p.run)) {
        runId = p.run;
      } else {
        throw new GhError(
          'command_failed',
          'run must be a numeric Actions run ID or a full run URL.',
        );
      }
    }

    const fetchRun = async (): Promise<GhRunData> => {
      const args = ['run', 'view'];
      if (runId) {
        args.push(runId);
      } else if (p.branch) {
        const listArgs = ['run', 'list', '--branch', p.branch, '--limit', '1'];
        if (repo) {
          listArgs.push('--repo', repo);
        }
        listArgs.push('--json', 'databaseId');
        const runs = await this.gh.json<
          Array<{ databaseId?: number } & GhJsonValue>
        >(listArgs, { cwd, signal });
        const newest = runs[0];
        if (runs.length === 0 || newest === undefined || !newest.databaseId) {
          throw new RunNotStartedError();
        }
        args.push(String(newest.databaseId));
      } else {
        throw new GhError(
          'command_failed',
          'run_watch requires `run` (a run ID or URL) or `branch`.',
        );
      }
      if (repo) {
        args.push('--repo', repo);
      }
      args.push('--json', GH_RUN_FIELDS.join(','));
      return this.gh.json<GhRunData & GhJsonValue>(args, { cwd, signal });
    };

    let polls = 0;
    let lastSignature = '';
    for (;;) {
      signal.throwIfAborted();
      polls += 1;
      let run: GhRunData;
      try {
        run = await fetchRun();
      } catch (error) {
        if (error instanceof RunNotStartedError) {
          if (Date.now() - startedAt >= RUN_WATCH_NO_RUNS_GIVE_UP_MS) {
            const waited = Math.round((Date.now() - startedAt) / 1000);
            return this.success(
              `No workflow run started for ${p.branch ?? 'the current branch'} after ${waited}s (${polls} polls). ` +
                'The commit may not trigger any workflow, or Actions may be disabled for this repository.',
            );
          }
        } else {
          throw error;
        }
        await delay(this.pollIntervalMs(startedAt), signal);
        continue;
      }

      const jobs = run.jobs ?? [];
      const failed = jobs.filter(isFailedJob);
      const outcome = runOutcome(run);
      const signature = `${run.status}:${run.conclusion ?? ''}:${jobs.length}`;
      if (signature !== lastSignature) {
        updateOutput?.(this.renderRunSnapshot(run, polls, failed.length));
        lastSignature = signature;
      }

      if (outcome === 'failure' || failed.length > 0) {
        return this.renderRunFailure(run, failed, tail, cwd, signal);
      }
      if (outcome === 'success') {
        return this.success(this.renderRunResult(run, failed));
      }
      if (Date.now() - startedAt >= RUN_WATCH_MAX_DURATION_MS) {
        return this.success(
          `${this.renderRunResult(run, failed)}\n\nWatch stopped after ${Math.round(
            (Date.now() - startedAt) / 1000,
          )}s while the run was still in progress. Re-run \`run_watch\` to continue watching.`,
        );
      }
      await delay(this.pollIntervalMs(startedAt), signal);
    }
  }

  private pollIntervalMs(startedAt: number): number {
    return Date.now() - startedAt < RUN_WATCH_FAST_WINDOW_MS
      ? RUN_WATCH_FAST_INTERVAL_MS
      : RUN_WATCH_SLOW_INTERVAL_MS;
  }

  private renderRunSnapshot(
    run: GhRunData,
    polls: number,
    failedCount: number,
  ): string {
    const lines: string[] = [
      `# Watching Actions run #${run.databaseId ?? '?'}`,
      '',
    ];
    pushLine(lines, 'Workflow', run.workflowName ?? run.name);
    pushLine(lines, 'Title', run.displayTitle);
    pushLine(lines, 'Branch', run.headBranch);
    pushLine(lines, 'Status', run.status);
    pushLine(lines, 'Conclusion', run.conclusion ?? undefined);
    pushLine(lines, 'Poll', polls);
    pushLine(lines, 'Failed jobs', failedCount > 0 ? failedCount : undefined);
    lines.push('', ...this.renderJobs(run.jobs ?? []));
    return lines.join('\n').trim();
  }

  private renderJobs(jobs: GhRunJob[]): string[] {
    if (jobs.length === 0) {
      return ['No jobs reported yet.'];
    }
    const lines: string[] = [`## Jobs (${jobs.length})`, ''];
    for (const job of jobs) {
      const conclusion = job.conclusion ?? job.status ?? 'queued';
      const marker = isFailedJob(job)
        ? '✗'
        : conclusion === 'success'
          ? '✓'
          : '…';
      lines.push(
        `- ${marker} ${job.name ?? `job-${job.databaseId}`} [${conclusion}]`,
      );
    }
    return lines;
  }

  private renderRunResult(run: GhRunData, failed: GhRunJob[]): string {
    const lines: string[] = [`# Actions run #${run.databaseId ?? '?'}`, ''];
    pushLine(lines, 'Workflow', run.workflowName ?? run.name);
    pushLine(lines, 'Title', run.displayTitle);
    pushLine(lines, 'Branch', run.headBranch);
    pushLine(lines, 'Status', run.status);
    pushLine(lines, 'Conclusion', run.conclusion ?? undefined);
    pushLine(lines, 'Created', run.createdAt);
    pushLine(lines, 'Updated', run.updatedAt);
    pushLine(lines, 'URL', run.url);
    lines.push('', ...this.renderJobs(run.jobs ?? []));
    lines.push('');
    lines.push(failed.length > 0 ? 'Run failed.' : 'All jobs passed.');
    return lines.join('\n').trim();
  }

  private async renderRunFailure(
    run: GhRunData,
    failed: GhRunJob[],
    tail: number,
    cwd: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const header = this.renderRunResult(run, failed);
    if (failed.length === 0 || !run.databaseId) {
      return this.success(header);
    }
    const logs: string[] = [];
    for (const job of failed) {
      if (!job.databaseId) {
        continue;
      }
      const args = [
        'run',
        'view',
        String(run.databaseId),
        '--job',
        String(job.databaseId),
        '--log-failed',
      ];
      const result = await this.gh.run(args, { cwd, signal });
      if (result.exitCode !== 0) {
        logs.push(
          `## ${job.name ?? 'job'}`,
          '',
          'Log unavailable:',
          result.stderr,
          '',
        );
        continue;
      }
      const logLines = result.stdout.split('\n');
      const excerpt = logLines.slice(-tail).join('\n');
      logs.push(
        `## ${job.name ?? 'job'} (last ${tail} lines)`,
        '',
        excerpt,
        '',
      );
    }
    const text = [
      header,
      '',
      ...(logs.length > 0 ? logs : ['No failed job logs were available.']),
    ]
      .join('\n')
      .trim();
    return this.success(text);
  }

  private extractUrl(output: string): string {
    const line = output
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith('https://'));
    return line ?? output.trim();
  }
}

/** Internal signal that the watched commit has not produced a run yet. */
class RunNotStartedError extends Error {
  constructor() {
    super('No workflow run has started yet.');
    this.name = 'RunNotStartedError';
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class GithubTool extends BaseDeclarativeTool<GithubParams, ToolResult> {
  static readonly Name = 'github';

  constructor(
    private readonly context: AgentLoopContext,
    messageBus: MessageBus,
  ) {
    super(
      GithubTool.Name,
      'GitHub',
      GITHUB_TOOL_DESCRIPTION,
      Kind.Execute,
      GITHUB_PARAMETER_SCHEMA,
      messageBus,
      true, // isOutputMarkdown
      true, // canUpdateOutput: run_watch streams progress
    );
  }

  protected override validateToolParamValues(
    params: GithubParams,
  ): string | null {
    if (!GITHUB_OPS[params.op]) {
      return `Unknown op "${String(params.op)}". Supported ops: ${Object.keys(GITHUB_OPS).join(', ')}.`;
    }

    switch (params.op) {
      case 'pr_view':
      case 'pr_checkout':
        return params.pr === undefined
          ? `op "${params.op}" requires \`pr\`.`
          : null;
      case 'issue_view':
        return params.issue === undefined
          ? 'op "issue_view" requires `issue`.'
          : null;
      case 'search_code':
      case 'search_issues':
        return params.query === undefined
          ? `op "${params.op}" requires \`query\`.`
          : null;
      case 'issue_create':
        return params.title === undefined
          ? 'op "issue_create" requires `title`.'
          : null;
      case 'pr_create':
        if (params.fill && (params.title || params.body !== undefined)) {
          return 'op "pr_create": `fill` cannot be combined with `title` or `body`.';
        }
        if (!params.fill && !params.title) {
          return 'op "pr_create" requires `title`, or `fill: true` to derive it from the commits.';
        }
        return null;
      case 'run_watch': {
        const hasBranch =
          typeof params.branch === 'string' && params.branch.length > 0;
        const run = params.run ?? '';
        if (!hasBranch && run.length === 0) {
          return 'op "run_watch" requires `run` (a run ID or URL) or `branch`.';
        }
        if (
          run.length > 0 &&
          !/^\d+$/.test(run) &&
          !RUN_URL_PATTERN.test(run)
        ) {
          return 'op "run_watch": `run` must be a numeric run ID or a full Actions run URL.';
        }
        return null;
      }
      default:
        return null;
    }
  }

  protected createInvocation(
    params: GithubParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<GithubParams, ToolResult> {
    return new GithubToolInvocation(
      this.context,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}
