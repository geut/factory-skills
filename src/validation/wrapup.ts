import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { WorkCommand } from '../config.ts';
import { factoryRootOf, ticketDirOf } from '../controller/keys.ts';
import type { FactorySnapshot, WrapupBaseline, WrapupValidationReport } from '../domain.ts';
import type { PullRequestInfo } from '../ports/code-host.ts';
import { qaPaths, taskCriteria, testPlan } from '../stages/qa/criteria.ts';
import { latestReviews } from '../stages/review/parse.ts';
import {
  checkIssueChecklist,
  openBoxes,
  type ChecklistContext,
} from '../stages/wrapup/checklist.ts';
import { handoffSections, WRAPUP_HEADINGS } from '../stages/wrapup/handoff.ts';
import {
  errorReport,
  failedReport,
  passedReport,
  type ValidationCheck,
  type Validator,
} from './report.ts';

export const WRAPUP_VALIDATOR_VERSION = 'wrapup.v2';

// Validates the wrap-up handoff against the repository, not the agent's
// claims. The headings are checked for completeness; the prose is not parsed
// for operational state.

// Controller-owned or transient parts of the factory root: the server writes
// `runtime/` (Herdr tabs, the handshake) and `local.token`, and another
// ticket's start may move a forgotten run's files to `archive/`, while
// wrap-up runs.
const factoryInternal = new Set([
  'db',
  'sessions',
  'worktrees',
  'runtime',
  'local.token',
  'archive',
  'node_modules',
  '.git',
]);

type Git = { code: number; stderr: string; stdout: string };

function git(cwd: string, args: Array<string>): Git {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status ?? 1, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

function gitOk(cwd: string, args: Array<string>): string {
  const result = git(cwd, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function hashFile(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return 'deleted';
  }
}

// Other tickets keep running beside this one, so only this ticket's
// directory under `tickets/` is compared.
function factoryFiles(root: string, ticketDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const ownTicket = path.relative(root, ticketDir).split(path.sep).join('/');
  const walk = (directory: string, prefix: string) => {
    let entries: Array<string>;
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (prefix === '' && factoryInternal.has(entry)) {
        continue;
      }
      const absolute = path.join(directory, entry);
      const relative = prefix === '' ? entry : `${prefix}/${entry}`;
      if (prefix === 'tickets' && relative !== ownTicket) {
        continue;
      }
      const stats = statSync(absolute, { throwIfNoEntry: false });
      if (stats?.isDirectory() === true) {
        walk(absolute, relative);
      } else if (stats?.isFile() === true) {
        files[relative] = hashFile(absolute);
      }
    }
  };
  walk(root, '');
  return files;
}

// Paths that differ from the base commit: committed, staged, unstaged, and
// untracked, each with a content hash (`deleted` when removed).
function worktreeChanges(worktree: string, baseSha: string): Record<string, string> {
  const listed = new Set<string>();
  const status = gitOk(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = status.split('\0');
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index] ?? '';
    if (entry.length < 4) {
      continue;
    }
    listed.add(entry.slice(3));
    // A rename or copy carries its source path in the next field.
    if (entry[0] === 'R' || entry[0] === 'C') {
      index += 1;
      const source = parts[index];
      if (source !== undefined && source.length > 0) {
        listed.add(source);
      }
    }
  }
  for (const name of gitOk(worktree, ['diff', '--name-only', '-z', baseSha]).split('\0')) {
    if (name.length > 0) {
      listed.add(name);
    }
  }
  const changes: Record<string, string> = {};
  for (const name of [...listed].sort()) {
    changes[name] = hashFile(path.join(worktree, name));
  }
  return changes;
}

function remoteRefs(worktree: string, branch: string): Record<string, string> {
  const refs: Record<string, string> = {};
  const listed = git(worktree, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/remotes/',
  ]);
  for (const line of listed.stdout.split('\n')) {
    const [ref, sha] = line.trim().split(' ');
    if (ref !== undefined && sha !== undefined && ref.endsWith(`/${branch}`)) {
      refs[ref] = sha;
    }
  }
  return refs;
}

function refSha(cwd: string, ref: string): string | null {
  const result = git(cwd, ['rev-parse', '--verify', '--quiet', ref]);
  return result.code === 0 ? result.stdout.trim() : null;
}

export function captureWrapupState(input: {
  baseBranch: string | null;
  baseSha: string;
  branch: string;
  codeRoot: string;
  factoryRoot: string;
  ticketDir: string;
  worktree: string;
}): WrapupBaseline {
  return {
    baseHead:
      input.baseBranch === null ? null : refSha(input.codeRoot, `refs/heads/${input.baseBranch}`),
    branch: input.branch,
    factory: factoryFiles(input.factoryRoot, input.ticketDir),
    head: gitOk(input.worktree, ['rev-parse', 'HEAD']).trim(),
    remotes: remoteRefs(input.worktree, input.branch),
    worktree: worktreeChanges(input.worktree, input.baseSha),
  };
}

export function parseBaseline(text: string): WrapupBaseline | null {
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === 'object' &&
      value !== null &&
      'head' in value &&
      typeof value.head === 'string' &&
      'worktree' in value &&
      'factory' in value &&
      'remotes' in value
    ) {
      return value as WrapupBaseline;
    }
  } catch {
    return null;
  }
  return null;
}

function cleanPath(value: string): string {
  return value
    .trim()
    .replace(/^\.\//, '')
    .replace(/[,;:]$/, '');
}

// Paths named in the Files section: backticked tokens first, else the
// first path-like word of each list item.
export function listedPaths(section: string): Set<string> {
  const paths = new Set<string>();
  for (const line of section.split('\n')) {
    const quoted = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    const candidates =
      quoted.length > 0
        ? quoted
        : line
            .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
            .replace(/^\*\*[^*]+\*\*:?\s*/, '')
            .split(/\s+/)
            .slice(0, 1);
    for (const candidate of candidates) {
      const value = cleanPath(candidate);
      if (
        value.length > 0 &&
        !value.includes(' ') &&
        !/^[a-z]+:\/\//i.test(value) &&
        (value.includes('/') || /\.[A-Za-z0-9]+$/.test(value))
      ) {
        paths.add(value);
      }
    }
  }
  return paths;
}

function matchesGenerated(file: string, patterns: Array<string>): boolean {
  return patterns.some((pattern) => {
    if (!pattern.includes('*')) {
      return pattern.endsWith('/') ? file.startsWith(pattern) : file === pattern;
    }
    const regex = new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`))
        .join('.*')}$`,
    );
    return regex.test(file) || regex.test(path.basename(file));
  });
}

function isDocumentation(file: string): boolean {
  return /\.(md|mdx|txt|rst|adoc)$/i.test(file) || file.startsWith('docs/');
}

function changed(before: Record<string, string>, after: Record<string, string>): Array<string> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => (before[key] ?? 'unchanged') !== (after[key] ?? 'unchanged'))
    .sort();
}

const allowedFactory = (file: string) =>
  file === 'CONTEXT.md' || file === 'PRD.md' || file.startsWith('learnings/');

const pullRequestUrl = /https?:\/\/\S+\/pull\/\d+/;

function check(
  name: string,
  kind: ValidationCheck['kind'],
  failures: Array<string>,
  passed: string,
): ValidationCheck {
  return {
    details: failures.length === 0 ? passed : failures.join('\n'),
    kind,
    name,
    status: failures.length === 0 ? 'passed' : 'failed',
  };
}

// With codeHost.pullRequests on, wrap-up commits the approved work. Its
// commits must sit on top of the commit it started from, on the ticket
// branch, with no merge, and hold only paths ## Files names.
function commitFailures(input: {
  branch: string;
  codeRoot: string;
  from: string;
  head: string;
  listed: Set<string>;
  worktree: string;
}): Array<string> {
  if (git(input.worktree, ['merge-base', '--is-ancestor', input.from, input.head]).code !== 0) {
    return [
      `HEAD ${input.head} does not contain ${input.from}, the commit wrap-up started from. Do not amend, rebase, or reset commits made before wrap-up.`,
    ];
  }
  const failures: Array<string> = [];
  const branchHead = refSha(input.codeRoot, `refs/heads/${input.branch}`);
  if (branchHead !== null && branchHead !== input.head) {
    failures.push(
      `The commits are not on ${input.branch}: the branch is at ${branchHead}, HEAD is ${input.head}.`,
    );
  }
  const range = `${input.from}..${input.head}`;
  const merges = gitOk(input.worktree, ['rev-list', '--merges', range]).trim();
  if (merges.length > 0) {
    failures.push(
      `Wrap-up made a merge commit (${merges.split('\n').join(', ')}); commit the approved work directly on ${input.branch}.`,
    );
  }
  const committed = gitOk(input.worktree, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    input.from,
    input.head,
  ])
    .split('\0')
    .filter((name) => name.length > 0);
  for (const file of committed) {
    if (!input.listed.has(file)) {
      failures.push(`The commit includes ${file}, which ## Files does not list.`);
    }
  }
  return failures;
}

// The code host's view of the pull request at a URL.
export type PullRequestLookup = (url: string) => PullRequestInfo | { missing: true };

export function validateWrapup(input: {
  baseBranch: string | null;
  baseline: WrapupBaseline;
  baseSha: string;
  branch: string;
  // What the issue checklist is checked against, but the worktree.
  checklist: Omit<ChecklistContext, 'exists'>;
  codeRoot: string;
  commands: Array<WorkCommand>;
  factoryRoot: string;
  findPullRequest: PullRequestLookup;
  generated: Array<string>;
  output: string;
  pullRequests: boolean;
  ticketDir: string;
  // The all-stage usage table, read once the checks are done.
  usage: () => string;
  worktree: string;
}): WrapupValidationReport {
  let current: WrapupBaseline;
  let dirty: boolean;
  let branchExists: boolean;
  try {
    current = captureWrapupState(input);
    dirty = gitOk(input.worktree, ['status', '--porcelain']).trim().length > 0;
    branchExists = refSha(input.codeRoot, `refs/heads/${input.branch}`) !== null;
  } catch (error: unknown) {
    return errorReport(
      WRAPUP_VALIDATOR_VERSION,
      error instanceof Error ? error.message : String(error),
    );
  }

  const sections = handoffSections(input.output);
  const section = (name: string) => sections.get(name.toLowerCase()) ?? '';
  const missing = WRAPUP_HEADINGS.filter((name) => !sections.has(name.toLowerCase()));
  const checks: Array<ValidationCheck> = [
    check(
      'handoff headings',
      'schema',
      missing.map((name) => `## ${name} is missing.`),
      'factory.wrapup.v2',
    ),
  ];

  // Files lists every changed path, and only changed paths.
  const factoryPrefix = path.relative(input.codeRoot, input.factoryRoot).split(path.sep).join('/');
  const factoryChanges = changed(input.baseline.factory, current.factory);
  const actual = new Set(Object.keys(current.worktree));
  const listed = listedPaths(section('Files'));
  const knownFactory = new Set(factoryChanges.map((file) => `${factoryPrefix}/${file}`));
  checks.push(
    check(
      'files section',
      'diff',
      [
        ...[...actual]
          .filter((file) => !listed.has(file))
          .map((file) => `## Files does not list changed path ${file}.`),
        ...[...listed]
          .filter((file) => !actual.has(file) && !knownFactory.has(file))
          .map((file) => `## Files lists ${file}, which did not change.`),
      ],
      `${actual.size} changed path${actual.size === 1 ? '' : 's'} listed`,
    ),
  );

  // Tests name the commands the controller ran during work validation.
  const tests = section('Tests').toLowerCase();
  checks.push(
    check(
      'tests section',
      'artifact',
      input.commands
        .filter(
          (command) =>
            !tests.includes(command.name.toLowerCase()) &&
            !tests.includes(command.argv.join(' ').toLowerCase()),
        )
        .map(
          (command) =>
            `## Tests does not mention the validation command ${command.name} (${command.argv.join(' ')}).`,
        ),
      input.commands.length === 0
        ? 'no validation commands are configured'
        : 'every validation command is named',
    ),
  );

  // The issue's boxes and decisions, which the controller writes to the issue.
  const checklist = checkIssueChecklist(section('Issue checklist'), section('Decisions'), {
    ...input.checklist,
    exists: (file) => {
      const resolved = path.resolve(input.worktree, file);
      return (
        resolved.startsWith(`${path.resolve(input.worktree)}${path.sep}`) && existsSync(resolved)
      );
    },
  });
  checks.push(
    check(
      'issue checklist',
      'schema',
      checklist.failures,
      `${checklist.result.met.length} met, ${checklist.result.open.length} open, ${checklist.result.decisions.length} decision${checklist.result.decisions.length === 1 ? '' : 's'}`,
    ),
  );

  const merge = section('Merge commands');
  let checked: PullRequestInfo | null = null;
  const url = pullRequestUrl.exec(merge)?.[0] ?? null;
  const commands = merge.includes(input.worktree) && merge.includes(input.branch);
  checks.push(
    check(
      'merge commands',
      'artifact',
      url !== null || commands
        ? []
        : [
            `## Merge commands needs a pull-request URL, or commands that name the worktree ${input.worktree} and the branch ${input.branch}.`,
          ],
      url ?? 'commands name the worktree and branch',
    ),
  );

  // The wrap-up agent changes no product code. A documentation or
  // generated-artifact change is allowed when the handoff names it.
  const touched = changed(input.baseline.worktree, current.worktree);
  checks.push(
    check(
      'no product code',
      'diff',
      touched.flatMap((file) => {
        if (path.basename(file) === 'wrapup.md' || file.split('/').includes('visuals')) {
          return [`Wrap-up created ${file}; keep the handoff in the session instead.`];
        }
        if (!isDocumentation(file) && !matchesGenerated(file, input.generated)) {
          return [
            `Wrap-up changed product code: ${file}. Route code changes back through work and review.`,
          ];
        }
        if (!listed.has(file)) {
          return [`Wrap-up changed ${file} without naming it in ## Files.`];
        }
        return [];
      }),
      touched.length === 0
        ? 'wrap-up changed no worktree file'
        : `${touched.length} documented change(s)`,
    ),
    // The factory root keeps only durable knowledge from wrap-up.
    check(
      'factory files',
      'policy',
      factoryChanges
        .filter((file) => !allowedFactory(file))
        .map(
          (file) =>
            `Wrap-up changed ${factoryPrefix}/${file}; only CONTEXT.md, PRD.md, and learnings/ may change.`,
        ),
      factoryChanges.length === 0 ? 'unchanged' : factoryChanges.join(', '),
    ),
  );

  const gitFailures: Array<string> = [];
  const committed = current.head !== input.baseline.head;
  if (committed && !input.pullRequests) {
    gitFailures.push(
      `A commit was made: HEAD moved from ${input.baseline.head} to ${current.head}.`,
    );
  } else if (committed) {
    try {
      gitFailures.push(
        ...commitFailures({
          branch: input.branch,
          codeRoot: input.codeRoot,
          from: input.baseline.head,
          head: current.head,
          listed,
          worktree: input.worktree,
        }),
      );
    } catch (error: unknown) {
      return errorReport(
        WRAPUP_VALIDATOR_VERSION,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (!branchExists) {
    gitFailures.push(`The branch ${input.branch} was deleted.`);
  }
  if (input.baseline.baseHead !== current.baseHead) {
    gitFailures.push(
      `The base branch ${input.baseBranch ?? ''} moved; nothing may merge during wrap-up.`,
    );
  }
  checks.push(
    input.pullRequests
      ? check(
          'ticket commits',
          'policy',
          gitFailures,
          committed ? `committed on ${input.branch} at ${current.head}` : `HEAD is ${current.head}`,
        )
      : check('no commit or merge', 'policy', gitFailures, `HEAD is ${current.head}`),
  );

  const pushed = changed(input.baseline.remotes, current.remotes).length > 0;
  const policy: Array<string> = [];
  if (!input.pullRequests) {
    if (pushed) {
      policy.push(`The branch was pushed, but codeHost.pullRequests is off.`);
    }
    if (!commands) {
      policy.push(
        'codeHost.pullRequests is off, so ## Merge commands must list commit and merge commands.',
      );
    }
  } else if (dirty) {
    if (committed) {
      policy.push(
        'Wrap-up committed part of the work and left the rest uncommitted; commit every path in ## Files, or none.',
      );
    }
    if (pushed) {
      policy.push('The branch was pushed while the worktree has uncommitted changes.');
    }
    if (url !== null) {
      policy.push('A pull request was reported while the worktree has uncommitted changes.');
    }
  } else if (url === null) {
    policy.push(
      'The worktree is clean and codeHost.pullRequests is on, so ## Merge commands needs the pull-request URL.',
    );
  } else {
    let found: ReturnType<PullRequestLookup>;
    try {
      found = input.findPullRequest(url);
      checked = 'missing' in found ? null : found;
    } catch (error: unknown) {
      return errorReport(
        WRAPUP_VALIDATOR_VERSION,
        error instanceof Error ? error.message : String(error),
      );
    }
    if ('missing' in found) {
      policy.push(`No pull request exists at ${url}.`);
    } else if (found.headBranch !== input.branch) {
      policy.push(`${url} is for ${found.headBranch}, not ${input.branch}.`);
    } else if (found.headSha !== current.head) {
      policy.push(
        `${url} has head ${found.headSha ?? 'unknown'}, not the local HEAD ${current.head}; push ${input.branch}.`,
      );
    }
  }
  checks.push(
    check(
      'pull-request policy',
      'policy',
      policy,
      input.pullRequests
        ? dirty
          ? 'not pushed: uncommitted changes'
          : `pull request ${url ?? ''}`
        : 'not pushed',
    ),
  );

  const failures = checks
    .filter((item) => item.status === 'failed')
    .flatMap((item) => item.details.split('\n'));
  const detail = {
    checklist: checklist.result,
    pullRequest: policy.length === 0 ? checked : null,
    usage: input.usage(),
  };
  return failures.length === 0
    ? passedReport(WRAPUP_VALIDATOR_VERSION, checks, detail)
    : failedReport(WRAPUP_VALIDATOR_VERSION, checks, failures, detail);
}

function outputOf(resultJson: string | null): string {
  try {
    const parsed: unknown = JSON.parse(resultJson ?? '{}');
    return typeof parsed === 'object' &&
      parsed !== null &&
      'output' in parsed &&
      typeof parsed.output === 'string'
      ? parsed.output
      : '';
  } catch {
    return '';
  }
}

// QA's test plan for a task; empty when QA did not run for it.
function readQaPlan(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// The issue's open boxes, each task's criteria, and the findings its latest
// review left open.
function issueContext(snapshot: FactorySnapshot): Omit<ChecklistContext, 'exists'> {
  const { execution, ticket } = snapshot;
  const reviews = latestReviews(snapshot);
  return {
    boxes: openBoxes(ticket),
    criteria: new Map(
      snapshot.tasks.map((task) => [
        task.taskId,
        taskCriteria(path.join(execution.factoryDir, task.taskFile)).map((item) => item.id),
      ]),
    ),
    findings: reviews.flatMap(({ result, taskId }) =>
      result.findings.map((finding) => ({ finding, taskId })),
    ),
    proven: new Map(
      snapshot.tasks.map((task) => [
        task.taskId,
        [
          ...(reviews.find((item) => item.taskId === task.taskId)?.result.verification ?? [])
            .filter((line) => line.status === 'verified')
            .map((line) => line.id),
          ...testPlan(readQaPlan(qaPaths(execution.factoryDir, task.taskId).plan)).map(
            (row) => row.criterion,
          ),
        ],
      ]),
    ),
  };
}

export const wrapupValidator: Validator<'wrapup'> = {
  validate: ({ deps, run, session, snapshot }) => {
    const { execution } = snapshot;
    // The baseline is taken when the first wrap-up input is prepared.
    const baselineText =
      snapshot.runs.find((item) => item.sessionId === session.id && item.baseline !== null)
        ?.baseline ?? null;
    const baseline = baselineText === null ? null : parseBaseline(baselineText);
    if (
      baseline === null ||
      execution.worktreeBaseSha === null ||
      execution.worktreeBranch === null ||
      execution.worktreePath === null
    ) {
      return Promise.resolve(
        errorReport(WRAPUP_VALIDATOR_VERSION, 'The wrap-up baseline or worktree is missing.'),
      );
    }
    return Promise.resolve(
      validateWrapup({
        baseBranch: execution.worktreeBaseBranch,
        baseline,
        baseSha: execution.worktreeBaseSha,
        branch: execution.worktreeBranch,
        checklist: issueContext(snapshot),
        codeRoot: execution.policy.codeRoot,
        commands: execution.policy.validation.work.commands,
        factoryRoot: factoryRootOf(execution.factoryDir),
        findPullRequest: deps.findPullRequest,
        generated: execution.policy.validation.wrapup.generated,
        output: outputOf(run.resultJson),
        pullRequests: execution.policy.pullRequests,
        ticketDir: ticketDirOf(execution.factoryDir),
        usage: deps.usage,
        worktree: execution.worktreePath,
      }),
    );
  },
  version: WRAPUP_VALIDATOR_VERSION,
};
