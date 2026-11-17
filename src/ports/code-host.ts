import { spawn, spawnSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CodeHostConfig } from '../config.ts';
import {
  FACTORY_MARKER,
  FEEDBACK_QUERY,
  feedbackFrom,
  type PullRequestFeedback,
} from './pull-request-feedback.ts';

// The code host port: how the factory reads pull requests, their feedback, and
// checks webhook deliveries. It only reads; the wrap-up agent opens the pull
// request itself.
// GitHub is the only adapter so far, through gh.

export type PullRequestInfo = {
  author: string | null;
  closedAt: string | null;
  headBranch: string;
  // The commit the pull request's branch points at, when the host reports it.
  headSha: string | null;
  mergedAt: string | null;
  number: number;
  openedAt: string | null;
  state: 'closed' | 'merged' | 'open';
  title: string;
  url: string;
};

export type PullRequestReview = {
  author: string;
  authorType: 'bot' | 'human';
  commitSha: string | null;
  hasBody: boolean;
  id: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
  submittedAt: string | null;
};

export type PullRequestOutcome = {
  commits: Array<{ committedAt: string | null; sha: string }>;
  pullRequest: PullRequestInfo;
  reviews: Array<PullRequestReview>;
};

export type CodeHost = {
  // Posts `markdown` on the pull request at `url`, or replaces the comment
  // posted before under `key`. Rejects when the host refuses or cannot be
  // reached.
  commentOnPullRequest: (url: string, key: string, markdown: string) => Promise<void>;
  // The open, merged, or closed pull request whose head is `branch`.
  findPullRequest: (branch: string) => PullRequestInfo | null;
  kind: string;
  // Null when no pull request exists at `url`. Throws on infrastructure errors.
  pullRequest: (url: string) => PullRequestInfo | null;
  // The feedback on `pullRequest` that is still pending: not in `seen`, the
  // comment ids earlier rounds took or the operator dismissed.
  pullRequestFeedback: (
    pullRequest: PullRequestInfo,
    seen: ReadonlySet<string>,
  ) => PullRequestFeedback;
  pullRequestOutcome: (pullRequest: PullRequestInfo) => PullRequestOutcome;
  // Replaces the body of the pull request at `url`. Rejects when the host
  // refuses or cannot be reached.
  setPullRequestBody: (url: string, body: string) => Promise<void>;
  // Whether a webhook delivery is signed with `secret`.
  verifyWebhook: (
    headers: Record<string, string | undefined>,
    rawBody: Buffer,
    secret: string,
  ) => boolean;
};

// The code host's repository as `owner/repo`, as gh and GitHub refs name it.
export function codeHostRepo(config: Pick<CodeHostConfig, 'owner' | 'repo'>): string {
  return `${config.owner}/${config.repo}`;
}

// Runs gh and parses its JSON output. Tests pass a stand-in.
export type GhJson = (args: Array<string>) => unknown;

export const ghJson: GhJson = (args) => {
  // A pull request's feedback can run past spawnSync's 1 MiB default.
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'gh failed').trim());
  }
  return JSON.parse(result.stdout) as unknown;
};

// Runs a gh command the outbox awaits, with `input` on its stdin, and gives
// back its output. It runs as a child process, so a slow GitHub never blocks
// the event loop; the timeout only ends a gh that is stuck.
export type GhRun = (args: Array<string>, input: string) => Promise<string>;

export const GH_WRITE_TIMEOUT_MS = 5 * 60 * 1000;

export function runCommand(input: {
  args: Array<string>;
  command: string;
  stdin: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: input.timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          signal === null
            ? (stderr || stdout).trim() || `${input.command} exited with code ${code ?? 'unknown'}`
            : `${input.command} was stopped by ${signal} after ${input.timeoutMs} ms`,
        ),
      );
    });
    // A command that exits before reading stdin must not crash the server.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input.stdin);
  });
}

export const ghRun: GhRun = (args, stdin) =>
  runCommand({ args, command: 'gh', stdin, timeoutMs: GH_WRITE_TIMEOUT_MS });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const PR_FIELDS =
  'number,url,title,headRefName,headRefOid,state,author,createdAt,mergedAt,closedAt';

function pullRequestFrom(value: unknown): PullRequestInfo | null {
  if (!isRecord(value) || typeof value['number'] !== 'number' || typeof value['url'] !== 'string') {
    return null;
  }
  const state = String(value['state'] ?? '').toLowerCase();
  const author = isRecord(value['author']) ? text(value['author']['login']) : null;
  return {
    author,
    closedAt: text(value['closedAt']),
    headBranch: String(value['headRefName'] ?? ''),
    headSha: text(value['headRefOid']),
    mergedAt: text(value['mergedAt']),
    number: value['number'],
    openedAt: text(value['createdAt']),
    state: state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open',
    title: typeof value['title'] === 'string' ? value['title'] : '',
    url: value['url'],
  };
}

const reviewStates: Record<string, PullRequestReview['state']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
};

function reviewFrom(value: unknown): PullRequestReview | null {
  if (!isRecord(value) || value['id'] === undefined) {
    return null;
  }
  const user = isRecord(value['user']) ? value['user'] : {};
  const login = text(user['login']) ?? 'ghost';
  return {
    author: login,
    authorType: user['type'] === 'Bot' || login.endsWith('[bot]') ? 'bot' : 'human',
    commitSha: text(value['commit_id']),
    hasBody: typeof value['body'] === 'string' && value['body'].trim().length > 0,
    id: String(value['id']),
    state: reviewStates[String(value['state'])] ?? 'commented',
    submittedAt: text(value['submitted_at']),
  };
}

function commitFrom(value: unknown): { committedAt: string | null; sha: string } | null {
  if (!isRecord(value) || typeof value['sha'] !== 'string') {
    return null;
  }
  const commit = isRecord(value['commit']) ? value['commit'] : {};
  const committer = isRecord(commit['committer']) ? commit['committer'] : {};
  return { committedAt: text(committer['date']), sha: value['sha'] };
}

function notFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    /no pull requests? found|could not resolve|not found/i.test(error.message)
  );
}

// The repository and number of a pull request URL, or null for another URL.
function pullRequestPath(url: string): { number: string; repo: string } | null {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  const [, owner, name, number] = match ?? [];
  return owner === undefined || name === undefined || number === undefined
    ? null
    : { number, repo: `${owner}/${name}` };
}

// A write needs a pull request URL; anything else is refused before gh runs.
function writablePullRequest(url: string): { number: string; repo: string } {
  const found = pullRequestPath(url);
  if (found === null) {
    throw new Error(`${url} is not a pull request URL.`);
  }
  return found;
}

// `gh api --paginate` prints one JSON array per page; --slurp joins them.
function pages(value: unknown): Array<unknown> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.every(Array.isArray) ? value.flat() : value;
}

export function verifyGithubSignature(
  headers: Record<string, string | undefined>,
  rawBody: Buffer,
  secret: string,
): boolean {
  const signature = headers['x-hub-signature-256'] ?? '';
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export function createGithubCodeHost(
  config: CodeHostConfig | null,
  gh: GhJson = ghJson,
  write: GhRun = ghRun,
): CodeHost {
  const repo = config === null ? null : codeHostRepo(config);
  function repoOf(url: string): string {
    return pullRequestPath(url)?.repo ?? repo ?? '';
  }
  return {
    findPullRequest: (branch) => {
      if (repo === null) {
        return null;
      }
      const found = gh([
        'pr',
        'list',
        '--repo',
        repo,
        '--head',
        branch,
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        PR_FIELDS,
      ]);
      return Array.isArray(found) ? pullRequestFrom(found[0]) : null;
    },
    kind: 'github',
    pullRequest: (url) => {
      try {
        return pullRequestFrom(gh(['pr', 'view', url, '--json', PR_FIELDS]));
      } catch (error: unknown) {
        if (notFound(error)) {
          return null;
        }
        throw error;
      }
    },
    pullRequestFeedback: (pullRequest, seen) => {
      const [owner, name] = repoOf(pullRequest.url).split('/');
      const payload = gh([
        'api',
        'graphql',
        '-f',
        `query=${FEEDBACK_QUERY}`,
        // -f keeps a name such as `2048` a string; -F types the number.
        '-f',
        `owner=${owner ?? ''}`,
        '-f',
        `repo=${name ?? ''}`,
        '-F',
        `number=${pullRequest.number}`,
      ]);
      return feedbackFrom(payload, { authors: config?.feedbackAuthors ?? [], seen });
    },
    // The body goes through stdin, so no shell or argument length limit
    // touches it.
    pullRequestOutcome: (pullRequest) => {
      const base = `repos/${repoOf(pullRequest.url)}/pulls/${pullRequest.number}`;
      const fresh = gh(['pr', 'view', pullRequest.url, '--json', PR_FIELDS]);
      const reviews = pages(gh(['api', '--paginate', '--slurp', `${base}/reviews`]));
      const commits = pages(gh(['api', '--paginate', '--slurp', `${base}/commits`]));
      return {
        commits: commits.flatMap((item) => {
          const commit = commitFrom(item);
          return commit === null ? [] : [commit];
        }),
        pullRequest: pullRequestFrom(fresh) ?? pullRequest,
        reviews: reviews.flatMap((item) => {
          const review = reviewFrom(item);
          return review === null ? [] : [review];
        }),
      };
    },
    // Through the REST API, like the reads here: `gh pr edit` fails on some
    // gh versions over Projects (classic). The body goes through stdin, so no
    // shell or argument length limit touches it.
    setPullRequestBody: async (url, body) => {
      const { number, repo: target } = writablePullRequest(url);
      await write(['api', '-X', 'PATCH', `repos/${target}/pulls/${number}`, '-F', 'body=@-'], body);
    },
    // The hidden marker finds the comment again, and tells the feedback reader
    // it is the factory's own.
    commentOnPullRequest: async (url, key, markdown) => {
      const { number, repo: target } = writablePullRequest(url);
      const marker = `${FACTORY_MARKER}${key} -->`;
      const listed = pages(
        JSON.parse(
          await write(
            ['api', '--paginate', '--slurp', `repos/${target}/issues/${number}/comments`],
            '',
          ),
        ),
      );
      const existing = listed.find(
        (comment) =>
          isRecord(comment) &&
          typeof comment['body'] === 'string' &&
          comment['body'].includes(marker) &&
          typeof comment['id'] === 'number',
      );
      const body = `${markdown}\n\n${marker}`;
      await write(
        isRecord(existing)
          ? [
              'api',
              '-X',
              'PATCH',
              `repos/${target}/issues/comments/${String(existing['id'])}`,
              '-F',
              'body=@-',
            ]
          : ['api', '-X', 'POST', `repos/${target}/issues/${number}/comments`, '-F', 'body=@-'],
        body,
      );
    },
    verifyWebhook: verifyGithubSignature,
  };
}
