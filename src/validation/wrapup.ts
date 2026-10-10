import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { WorkCommand } from '../config.ts';
import type { WrapupBaseline, WrapupValidationReport } from '../domain.ts';
import { errorReport, failedReport, passedReport, type ValidationCheck } from './report.ts';

export const WRAPUP_VALIDATOR_VERSION = 'wrapup.v1';

// Validates the wrap-up handoff against the repository, not the agent's
// claims. The headings are checked for completeness; the prose is not parsed
// for operational state.

export const WRAPUP_HEADINGS = [
  'Outcome',
  'PR summary',
  'Files',
  'Tests',
  'Operations',
  'Limitations',
  'Merge commands',
] as const;

// Controller-owned or transient parts of the factory root.
const factoryInternal = new Set(['db', 'sessions', 'worktrees', 'node_modules', '.git']);

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

function factoryFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
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
  worktree: string;
}): WrapupBaseline {
  return {
    baseHead:
      input.baseBranch === null ? null : refSha(input.codeRoot, `refs/heads/${input.baseBranch}`),
    branch: input.branch,
    factory: factoryFiles(input.factoryRoot),
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

export function handoffSections(output: string): Map<string, string> {
  const sections = new Map<string, string>();
  const text = output.trim().replace(/^```[\w-]*\n([\s\S]*)\n```$/, '$1');
  const matches = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    sections.set((match[1] ?? '').trim().toLowerCase(), text.slice(start, end).trim());
  });
  return sections;
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

export type PullRequestLookup = (
  url: string,
) => { headRefName: string; state: string } | { missing: true };

export function validateWrapup(input: {
  baseBranch: string | null;
  baseline: WrapupBaseline;
  baseSha: string;
  branch: string;
  codeRoot: string;
  commands: Array<WorkCommand>;
  factoryRoot: string;
  findPullRequest: PullRequestLookup;
  generated: Array<string>;
  output: string;
  pullRequests: boolean;
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
      'factory.wrapup.v1',
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

  const merge = section('Merge commands');
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
  if (current.head !== input.baseline.head) {
    gitFailures.push(
      `A commit was made: HEAD moved from ${input.baseline.head} to ${current.head}.`,
    );
  }
  if (!branchExists) {
    gitFailures.push(`The branch ${input.branch} was deleted.`);
  }
  if (input.baseline.baseHead !== current.baseHead) {
    gitFailures.push(
      `The base branch ${input.baseBranch ?? ''} moved; nothing may merge during wrap-up.`,
    );
  }
  checks.push(check('no commit or merge', 'policy', gitFailures, `HEAD is ${current.head}`));

  const pushed = changed(input.baseline.remotes, current.remotes).length > 0;
  const policy: Array<string> = [];
  if (!input.pullRequests) {
    if (pushed) {
      policy.push(`The branch was pushed, but github.pullRequests is off.`);
    }
    if (!commands) {
      policy.push(
        'github.pullRequests is off, so ## Merge commands must list commit and merge commands.',
      );
    }
  } else if (dirty) {
    if (pushed) {
      policy.push('The branch was pushed while the worktree has uncommitted changes.');
    }
    if (url !== null) {
      policy.push('A pull request was reported while the worktree has uncommitted changes.');
    }
  } else if (url === null) {
    policy.push(
      'The worktree is clean and github.pullRequests is on, so ## Merge commands needs the pull-request URL.',
    );
  } else {
    let found: ReturnType<PullRequestLookup>;
    try {
      found = input.findPullRequest(url);
    } catch (error: unknown) {
      return errorReport(
        WRAPUP_VALIDATOR_VERSION,
        error instanceof Error ? error.message : String(error),
      );
    }
    if ('missing' in found) {
      policy.push(`No pull request exists at ${url}.`);
    } else if (found.headRefName !== input.branch) {
      policy.push(`${url} is for ${found.headRefName}, not ${input.branch}.`);
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
  const detail = { usage: input.usage() };
  return failures.length === 0
    ? passedReport(WRAPUP_VALIDATOR_VERSION, checks, detail)
    : failedReport(WRAPUP_VALIDATOR_VERSION, checks, failures, detail);
}
