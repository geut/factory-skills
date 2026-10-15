import { spawnSync } from 'node:child_process';
import type { TrackerConfig } from '../config.ts';
import {
  UnsupportedOperation,
  type IssueLink,
  type Resolved,
  type Tracker,
  type TrackerIssue,
} from './tracker.ts';

// GitHub Issues as a tracker, through the gh CLI. In a sandbox the proxy
// authenticates gh, so the adapter needs no token of its own.

export type RelatedIssue = {
  body: string;
  number: number;
  title: string;
  url: string | null;
};

export type GithubIssue = {
  body: string;
  host: string;
  labels: Array<string>;
  nodeId: string;
  number: number;
  owner: string;
  repo: string;
  title: string;
  url: string;
};

type IssueLocator = { host: string; number: number; owner: string; repo: string };

// The calls the adapter makes. Tests pass a stand-in.
export type GithubClient = {
  fetchIssue: (input: IssueLocator) => GithubIssue;
  listBlockedBy?: (input: Omit<IssueLocator, 'host'>) => Array<RelatedIssue>;
  listSubIssues: (input: Omit<IssueLocator, 'host'>) => Array<RelatedIssue>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ghJson(args: Array<string>): unknown {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'gh failed').trim());
  }
  const parsed: unknown = JSON.parse(result.stdout);
  return parsed;
}

function relatedIssues(path: string): Array<RelatedIssue> {
  const result = spawnSync('gh', ['api', path], { encoding: 'utf8' });
  if (result.status !== 0 || result.stdout.trim().length === 0) {
    return [];
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item) =>
    isRecord(item) && typeof item['number'] === 'number'
      ? [
          {
            body: typeof item['body'] === 'string' ? item['body'] : '',
            number: item['number'],
            title: typeof item['title'] === 'string' ? item['title'] : '',
            url: typeof item['html_url'] === 'string' ? item['html_url'] : null,
          },
        ]
      : [],
  );
}

export function githubCliClient(): GithubClient {
  return {
    fetchIssue(input) {
      const payload = ghJson([
        'issue',
        'view',
        String(input.number),
        '--repo',
        `${input.owner}/${input.repo}`,
        '--json',
        'id,number,title,body,url,labels',
      ]);
      if (
        !isRecord(payload) ||
        typeof payload['id'] !== 'string' ||
        typeof payload['number'] !== 'number'
      ) {
        throw new Error(
          `GitHub issue ${input.owner}/${input.repo}#${input.number} did not return an id.`,
        );
      }
      const labels = Array.isArray(payload['labels'])
        ? payload['labels'].flatMap((item) =>
            isRecord(item) && typeof item['name'] === 'string' ? [item['name']] : [],
          )
        : [];
      return {
        body: typeof payload['body'] === 'string' ? payload['body'] : '',
        host: input.host,
        labels,
        nodeId: payload['id'],
        number: payload['number'],
        owner: input.owner,
        repo: input.repo,
        title:
          typeof payload['title'] === 'string' ? payload['title'] : `Issue ${payload['number']}`,
        url: typeof payload['url'] === 'string' ? payload['url'] : '',
      };
    },
    listBlockedBy: (input) =>
      relatedIssues(
        `repos/${input.owner}/${input.repo}/issues/${input.number}/dependencies/blocked_by`,
      ),
    listSubIssues: (input) =>
      relatedIssues(`repos/${input.owner}/${input.repo}/issues/${input.number}/sub_issues`),
  };
}

// The GitHub refs a factory accepts: an issue URL, owner/repo#n, and #n or n
// for the configured repository. GitHub has no issue keys, so KEY-123 is not
// one of its refs.
export function githubTarget(
  ref: string,
  config: TrackerConfig | null,
): IssueLocator | { kind: 'error'; message: string } | null {
  const url = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(ref);
  if (url?.[1] && url[2] && url[3] && url[4]) {
    return { host: url[1], number: Number(url[4]), owner: url[2], repo: url[3] };
  }
  const qualified = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(ref);
  if (qualified?.[1] && qualified[2] && qualified[3]) {
    return {
      host: config?.host ?? 'github.com',
      number: Number(qualified[3]),
      owner: qualified[1],
      repo: qualified[2],
    };
  }
  const numbered = /^(?:#)?(\d+)$/.exec(ref);
  if (numbered?.[1]) {
    if (config === null) {
      return {
        kind: 'error',
        message: `Bare issue ${ref} needs tracker.owner and tracker.repo in FACTORY.json.`,
      };
    }
    return {
      host: config.host,
      number: Number(numbered[1]),
      owner: config.owner,
      repo: config.repo,
    };
  }
  return null;
}

function locate(issue: TrackerIssue): Omit<IssueLocator, 'host'> {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(issue.displayRef);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`${issue.displayRef} is not a GitHub issue.`);
  }
  return { number: Number(match[3]), owner: match[1], repo: match[2] };
}

function linkOf(owner: string, repo: string, related: RelatedIssue): IssueLink {
  const fromUrl = /\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(related.url ?? '');
  const displayRef =
    fromUrl?.[1] && fromUrl[2] && fromUrl[3]
      ? `${fromUrl[1]}/${fromUrl[2]}#${fromUrl[3]}`
      : `${owner}/${repo}#${related.number}`;
  return { displayRef, title: related.title, url: related.url };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'GitHub request failed';
}

export function createGithubTracker(config: TrackerConfig | null, client: GithubClient): Tracker {
  const listBlockedBy = client.listBlockedBy;
  return {
    blockedBy: (issue) => {
      if (listBlockedBy === undefined) {
        throw new UnsupportedOperation('github', 'blocking links');
      }
      const at = locate(issue);
      return listBlockedBy(at).map((related) => linkOf(at.owner, at.repo, related));
    },
    capabilities: new Set(listBlockedBy === undefined ? ['children'] : ['children', 'blockedBy']),
    children: (issue) => {
      const at = locate(issue);
      return client.listSubIssues(at).map((related) => linkOf(at.owner, at.repo, related));
    },
    kind: 'github',
    resolve: (ref): Resolved | null => {
      const target = githubTarget(ref, config);
      if (target === null) {
        return null;
      }
      if ('kind' in target) {
        return target;
      }
      let issue: GithubIssue;
      try {
        issue = client.fetchIssue(target);
      } catch (error: unknown) {
        return { kind: 'error', message: messageOf(error), reason: 'tracker_unavailable' };
      }
      return {
        issue: {
          body: issue.body,
          displayRef: `${issue.owner}/${issue.repo}#${issue.number}`,
          id: `github:${issue.host}:${issue.nodeId}`,
          labels: issue.labels,
          ref,
          title: issue.title,
          url: issue.url,
        },
        kind: 'issue',
      };
    },
  };
}
