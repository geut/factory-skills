import { spawnSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CodeHostConfig } from '../config.ts';

// The code host port: how the factory reads pull requests and checks webhook
// deliveries. It only reads; the wrap-up agent opens the pull request itself.
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
  // The open, merged, or closed pull request whose head is `branch`.
  findPullRequest: (branch: string) => PullRequestInfo | null;
  kind: string;
  // Null when no pull request exists at `url`. Throws on infrastructure errors.
  pullRequest: (url: string) => PullRequestInfo | null;
  pullRequestOutcome: (pullRequest: PullRequestInfo) => PullRequestOutcome;
  // Whether a webhook delivery is signed with `secret`.
  verifyWebhook: (
    headers: Record<string, string | undefined>,
    rawBody: Buffer,
    secret: string,
  ) => boolean;
};

// Runs gh and parses its JSON output. Tests pass a stand-in.
export type GhJson = (args: Array<string>) => unknown;

export const ghJson: GhJson = (args) => {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'gh failed').trim());
  }
  return JSON.parse(result.stdout) as unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const PR_FIELDS = 'number,url,headRefName,headRefOid,state,author,createdAt,mergedAt,closedAt';

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

export function createGithubCodeHost(config: CodeHostConfig | null, gh: GhJson = ghJson): CodeHost {
  const repo = config === null ? null : `${config.owner}/${config.repo}`;
  function repoOf(url: string): string {
    const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url);
    return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : (repo ?? '');
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
    verifyWebhook: verifyGithubSignature,
  };
}
