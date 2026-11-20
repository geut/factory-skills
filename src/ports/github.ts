import { z } from 'zod';
import type { GithubTrackerConfig } from '../config.ts';
import { ghJson, ghRun, type MaybePromise } from './gh.ts';
import { markdownChecklist, tickMarkdown } from './markdown-checklist.ts';
import {
  UnsupportedOperation,
  type IssueLink,
  type LinkedIssue,
  type LinkRelation,
  type TrackerCapability,
  type Resolved,
  type Tracker,
  type TrackerIssue,
} from './tracker.ts';

// GitHub Issues as a tracker, through the gh CLI. In a sandbox the proxy
// authenticates gh, so the adapter needs no token of its own.

export type RelatedIssue = {
  body: string;
  number: number;
  // Unknown reads as open, so a blocker is never dropped by mistake.
  state: 'closed' | 'open';
  title: string;
  url: string | null;
};

export type GithubIssue = {
  author: string | null;
  body: string;
  createdAt: string | null;
  host: string;
  labels: Array<string>;
  nodeId: string;
  number: number;
  owner: string;
  repo: string;
  title: string;
  updatedAt: string | null;
  url: string;
};

type IssueLocator = { host: string; number: number; owner: string; repo: string };

// An issue or pull request another issue links to or mentions.
export type GithubLinked = {
  comments: number;
  kind: 'issue' | 'pull_request';
  number: number;
  owner: string;
  // Pull requests that close it; a pull request is its own.
  pullRequests: Array<string>;
  repo: string;
  // OPEN, CLOSED, or MERGED; why an issue closed, such as COMPLETED.
  state: string;
  stateReason: string | null;
  title: string;
  url: string;
};

// An issue's native links, one level deep.
export type GithubLinks = {
  blockedBy: Array<GithubLinked>;
  blocking: Array<GithubLinked>;
  parent: GithubLinked | null;
  subIssues: Array<GithubLinked>;
};

// The calls the adapter makes. Tests pass a stand-in, which may answer at
// once; githubCliClient runs gh without blocking the server.
export type GithubClient = {
  addComment?: (input: Omit<IssueLocator, 'host'>, body: string) => MaybePromise<void>;
  editBody?: (input: Omit<IssueLocator, 'host'>, body: string) => MaybePromise<void>;
  editComment?: (input: Omit<IssueLocator, 'host'>, id: number, body: string) => MaybePromise<void>;
  editLabels?: (
    input: Omit<IssueLocator, 'host'>,
    add: Array<string>,
    remove: Array<string>,
  ) => MaybePromise<void>;
  fetchIssue: (input: IssueLocator) => MaybePromise<GithubIssue>;
  // The issue's parent, sub-issues, and blocking links.
  issueLinks?: (input: IssueLocator) => MaybePromise<GithubLinks>;
  listBlockedBy?: (input: Omit<IssueLocator, 'host'>) => MaybePromise<Array<RelatedIssue>>;
  listComments?: (
    input: Omit<IssueLocator, 'host'>,
  ) => MaybePromise<Array<{ body: string; id: number }>>;
  listIssues?: (input: {
    host: string;
    labels: Array<string>;
    milestone: string | null;
    owner: string;
    repo: string;
  }) => MaybePromise<Array<GithubIssue>>;
  listSubIssues: (input: Omit<IssueLocator, 'host'>) => MaybePromise<Array<RelatedIssue>>;
  // The issue or pull request a ref names; null when there is none.
  lookupRef?: (input: IssueLocator) => MaybePromise<GithubLinked | null>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A failed read lists none, as GitHub without sub-issues or dependencies does.
async function relatedIssues(path: string): Promise<Array<RelatedIssue>> {
  let output: string;
  try {
    output = await ghRun(['api', path], '');
  } catch {
    return [];
  }
  if (output.trim().length === 0) {
    return [];
  }
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item) =>
    isRecord(item) && typeof item['number'] === 'number'
      ? [
          {
            body: typeof item['body'] === 'string' ? item['body'] : '',
            number: item['number'],
            state: item['state'] === 'closed' ? ('closed' as const) : ('open' as const),
            title: typeof item['title'] === 'string' ? item['title'] : '',
            updatedAt: textOrNull(item['updatedAt']),
            url: typeof item['html_url'] === 'string' ? item['html_url'] : null,
          },
        ]
      : [],
  );
}

async function gh(args: Array<string>, input = ''): Promise<void> {
  await ghRun(args, input);
}

const LINKED_FIELDS = `number title url state stateReason repository { nameWithOwner }
  comments { totalCount }
  closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { url } }`;

// How many of each kind of link one read takes.
const LINKS_PAGE = 50;

const LinkedNode = z.object({
  closedByPullRequestsReferences: z.object({ nodes: z.array(z.object({ url: z.string() })) }),
  comments: z.object({ totalCount: z.number() }),
  number: z.number(),
  repository: z.object({ nameWithOwner: z.string() }),
  state: z.string(),
  stateReason: z.string().nullable(),
  title: z.string(),
  url: z.string(),
});

function linkedOf(
  node: z.output<typeof LinkedNode>,
  kind: GithubLinked['kind'] = 'issue',
): GithubLinked {
  const [owner = '', repo = ''] = node.repository.nameWithOwner.split('/');
  return {
    comments: node.comments.totalCount,
    kind,
    number: node.number,
    owner,
    pullRequests:
      kind === 'pull_request'
        ? [node.url]
        : node.closedByPullRequestsReferences.nodes.map((item) => item.url),
    repo,
    state: node.state,
    stateReason: node.stateReason,
    title: node.title,
    url: node.url,
  };
}

const page = z.object({ nodes: z.array(LinkedNode) });

const LinksResponse = z.object({
  data: z.object({
    repository: z.object({
      issue: z.object({
        blockedBy: page,
        blocking: page,
        parent: LinkedNode.nullable(),
        subIssues: page,
      }),
    }),
  }),
});

// A pull request has no closing references or state reason of its own.
const RefResponse = z.object({
  data: z.object({
    repository: z
      .object({
        issueOrPullRequest: z
          .discriminatedUnion('__typename', [
            LinkedNode.extend({ __typename: z.literal('Issue') }),
            LinkedNode.omit({ closedByPullRequestsReferences: true, stateReason: true }).extend({
              __typename: z.literal('PullRequest'),
            }),
          ])
          .nullable(),
      })
      .nullable(),
  }),
});

function graphqlArgs(host: string, query: string, at: Omit<IssueLocator, 'host'>): Array<string> {
  return [
    'api',
    'graphql',
    ...(host === 'github.com' ? [] : ['--hostname', host]),
    '-f',
    `query=${query}`,
    '-f',
    `owner=${at.owner}`,
    '-f',
    `name=${at.repo}`,
    '-F',
    `number=${at.number}`,
  ];
}

export function githubCliClient(): GithubClient {
  return {
    addComment: async (input, body) => {
      await gh(
        [
          'issue',
          'comment',
          String(input.number),
          '--repo',
          `${input.owner}/${input.repo}`,
          '--body-file',
          '-',
        ],
        body,
      );
    },
    editBody: async (input, body) => {
      await gh(
        [
          'issue',
          'edit',
          String(input.number),
          '--repo',
          `${input.owner}/${input.repo}`,
          '--body-file',
          '-',
        ],
        body,
      );
    },
    editComment: async (input, id, body) => {
      await gh(
        [
          'api',
          '--method',
          'PATCH',
          `repos/${input.owner}/${input.repo}/issues/comments/${id}`,
          '--field',
          'body=@-',
        ],
        body,
      );
    },
    editLabels: async (input, add, remove) => {
      await gh([
        'issue',
        'edit',
        String(input.number),
        '--repo',
        `${input.owner}/${input.repo}`,
        ...(add.length === 0 ? [] : ['--add-label', add.join(',')]),
        ...(remove.length === 0 ? [] : ['--remove-label', remove.join(',')]),
      ]);
    },
    async fetchIssue(input) {
      const payload = await ghJson([
        'issue',
        'view',
        String(input.number),
        '--repo',
        `${input.owner}/${input.repo}`,
        '--json',
        'id,number,title,body,url,labels,author,createdAt,updatedAt',
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
        author: authorOf(payload['author']),
        body: typeof payload['body'] === 'string' ? payload['body'] : '',
        createdAt: textOrNull(payload['createdAt']),
        host: input.host,
        labels,
        nodeId: payload['id'],
        number: payload['number'],
        owner: input.owner,
        repo: input.repo,
        title:
          typeof payload['title'] === 'string' ? payload['title'] : `Issue ${payload['number']}`,
        updatedAt: textOrNull(payload['updatedAt']),
        url: typeof payload['url'] === 'string' ? payload['url'] : '',
      };
    },
    issueLinks: async (input) => {
      const query = `query FactoryLinks($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { issue(number: $number) {
          parent { ${LINKED_FIELDS} }
          subIssues(first: ${LINKS_PAGE}) { nodes { ${LINKED_FIELDS} } }
          blockedBy(first: ${LINKS_PAGE}) { nodes { ${LINKED_FIELDS} } }
          blocking(first: ${LINKS_PAGE}) { nodes { ${LINKED_FIELDS} } }
        } }
      }`;
      const parsed = LinksResponse.parse(await ghJson(graphqlArgs(input.host, query, input)));
      const { issue } = parsed.data.repository;
      return {
        blockedBy: issue.blockedBy.nodes.map((node) => linkedOf(node)),
        blocking: issue.blocking.nodes.map((node) => linkedOf(node)),
        parent: issue.parent === null ? null : linkedOf(issue.parent),
        subIssues: issue.subIssues.nodes.map((node) => linkedOf(node)),
      };
    },
    listBlockedBy: (input) =>
      relatedIssues(
        `repos/${input.owner}/${input.repo}/issues/${input.number}/dependencies/blocked_by`,
      ),
    listComments: async (input) => {
      const payload = await ghJson([
        'api',
        '--paginate',
        '--slurp',
        `repos/${input.owner}/${input.repo}/issues/${input.number}/comments`,
      ]);
      const comments = Array.isArray(payload) ? payload.flat() : [];
      return comments.flatMap((item) =>
        isRecord(item) && typeof item['body'] === 'string' && typeof item['id'] === 'number'
          ? [{ body: item['body'], id: item['id'] }]
          : [],
      );
    },
    listIssues: async (input) => {
      const payload = await ghJson([
        'issue',
        'list',
        '--repo',
        `${input.owner}/${input.repo}`,
        '--state',
        'open',
        '--limit',
        '100',
        ...input.labels.flatMap((label) => ['--label', label]),
        ...(input.milestone === null ? [] : ['--milestone', input.milestone]),
        '--json',
        'id,number,title,body,url,labels,author,createdAt,updatedAt',
      ]);
      if (!Array.isArray(payload)) {
        return [];
      }
      return payload.flatMap((item) => {
        if (
          !isRecord(item) ||
          typeof item['id'] !== 'string' ||
          typeof item['number'] !== 'number'
        ) {
          return [];
        }
        const labels = Array.isArray(item['labels'])
          ? item['labels'].flatMap((label) =>
              isRecord(label) && typeof label['name'] === 'string' ? [label['name']] : [],
            )
          : [];
        return [
          {
            author: authorOf(item['author']),
            body: typeof item['body'] === 'string' ? item['body'] : '',
            createdAt: textOrNull(item['createdAt']),
            host: input.host,
            labels,
            nodeId: item['id'],
            number: item['number'],
            owner: input.owner,
            repo: input.repo,
            title: typeof item['title'] === 'string' ? item['title'] : '',
            updatedAt: textOrNull(item['updatedAt']),
            url: typeof item['url'] === 'string' ? item['url'] : '',
          },
        ];
      });
    },
    listSubIssues: (input) =>
      relatedIssues(`repos/${input.owner}/${input.repo}/issues/${input.number}/sub_issues`),
    // gh exits non-zero when the number names nothing: that is no link.
    lookupRef: async (input) => {
      const query = `query FactoryRef($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
          __typename
          ... on Issue { ${LINKED_FIELDS} }
          ... on PullRequest { number title url state repository { nameWithOwner } comments { totalCount } }
        } }
      }`;
      let payload: unknown;
      try {
        payload = await ghJson(graphqlArgs(input.host, query, input));
      } catch (error: unknown) {
        // GitHub's answer for a repository or number that names nothing;
        // anything else, such as a rate limit, is a failure.
        if (/Could not resolve to/i.test(error instanceof Error ? error.message : String(error))) {
          return null;
        }
        throw error;
      }
      const found = RefResponse.parse(payload).data.repository?.issueOrPullRequest ?? null;
      if (found === null) {
        return null;
      }
      return found.__typename === 'Issue'
        ? linkedOf(found)
        : linkedOf(
            { ...found, closedByPullRequestsReferences: { nodes: [] }, stateReason: null },
            'pull_request',
          );
    },
  };
}

// The GitHub refs a factory accepts: an issue URL, owner/repo#n, and #n or n
// for the configured repository. GitHub has no issue keys, so KEY-123 is not
// one of its refs.
export function githubTarget(
  ref: string,
  config: GithubTrackerConfig | null,
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

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// gh reports the author as `{ login, name, ... }`.
function authorOf(value: unknown): string | null {
  return isRecord(value) ? textOrNull(value['login']) : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'GitHub request failed';
}

// The issues and pull requests a body names, in order: issue and pull
// request URLs on `host`, owner/repo#n, and #n in the issue's own repository.
export function githubMentions(
  text: string,
  at: { owner: string; repo: string },
  host: string,
): Array<Omit<IssueLocator, 'host'>> {
  const site = host.replaceAll('.', String.raw`\.`);
  const pattern = new RegExp(
    `https?://${site}/([\\w.-]+)/([\\w.-]+)/(?:issues|pull)/(\\d+)|(?<![\\w/.-])([\\w.-]+)/([\\w.-]+)#(\\d+)\\b|(?<![\\w/#&])#(\\d+)\\b`,
    'g',
  );
  const found = new Map<string, Omit<IssueLocator, 'host'>>();
  for (const match of text.matchAll(pattern)) {
    const owner = match[1] ?? match[4] ?? at.owner;
    const repo = match[2] ?? match[5] ?? at.repo;
    const number = Number(match[3] ?? match[6] ?? match[7]);
    found.set(`${owner}/${repo}#${number}`.toLowerCase(), { number, owner, repo });
  }
  return [...found.values()];
}

// How many refs in a body are looked up at once.
const MENTION_BATCH = 5;

// The host an issue lives on, from its id (`github:<host>:<node id>`): a
// ticket may come from a URL on another host than FACTORY.json's.
function hostOf(issue: TrackerIssue, fallback: string): string {
  const [kind, host] = issue.id.split(':');
  return kind === 'github' && host !== undefined && host.length > 0 ? host : fallback;
}

function linkedIssue(linked: GithubLinked, relation: LinkRelation): LinkedIssue {
  return {
    comments: { count: linked.comments, more: false },
    displayRef: `${linked.owner}/${linked.repo}#${linked.number}`,
    pullRequests: linked.pullRequests,
    relation,
    state: linked.state.toLowerCase(),
    stateType: (linked.stateReason ?? linked.state).toLowerCase(),
    title: linked.title,
    url: linked.url,
  };
}

// The issue's links, each once: parent, sub-issues, blocking links, then the
// issues and pull requests its body names.
async function relatedOf(
  client: GithubClient,
  issueLinks: NonNullable<GithubClient['issueLinks']>,
  issue: TrackerIssue,
  host: string,
  room: number,
): Promise<{ issues: Array<LinkedIssue>; unread: number }> {
  const at = locate(issue);
  const self = `${at.owner}/${at.repo}#${at.number}`.toLowerCase();
  const links = await issueLinks({ ...at, host });
  const found = new Map<string, LinkedIssue>();
  const add = (linked: GithubLinked, relation: LinkRelation): void => {
    const key = `${linked.owner}/${linked.repo}#${linked.number}`.toLowerCase();
    if (key !== self && !found.has(key)) {
      found.set(key, linkedIssue(linked, relation));
    }
  };
  if (links.parent !== null) {
    add(links.parent, 'parent');
  }
  for (const item of links.subIssues) {
    add(item, 'sub-issue');
  }
  for (const item of links.blockedBy) {
    add(item, 'blocked by');
  }
  for (const item of links.blocking) {
    add(item, 'blocks');
  }
  const { lookupRef } = client;
  const mentioned = githubMentions(issue.body, at, host).filter((ref) => {
    const key = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
    return key !== self && !found.has(key);
  });
  if (lookupRef === undefined) {
    return { issues: [...found.values()], unread: mentioned.length };
  }
  // Refs are looked up only while there is room for them.
  let looked = 0;
  while (looked < mentioned.length && found.size < room) {
    const refs = mentioned.slice(looked, looked + Math.min(MENTION_BATCH, room - found.size));
    const batch = await Promise.all(refs.map(async (ref) => lookupRef({ ...ref, host })));
    looked += refs.length;
    for (const linked of batch) {
      if (linked !== null) {
        add(linked, 'mentioned');
      }
    }
  }
  return { issues: [...found.values()], unread: mentioned.length - looked };
}

function trackerIssue(issue: GithubIssue, ref: string): TrackerIssue {
  return {
    author: issue.author,
    body: issue.body,
    createdAt: issue.createdAt,
    displayRef: `${issue.owner}/${issue.repo}#${issue.number}`,
    id: `github:${issue.host}:${issue.nodeId}`,
    labels: issue.labels,
    ref,
    title: issue.title,
    updatedAt: issue.updatedAt,
    url: issue.url,
  };
}

export function createGithubTracker(
  config: GithubTrackerConfig | null,
  client: GithubClient,
): Tracker {
  const listBlockedBy = client.listBlockedBy;
  const listIssues = client.listIssues;
  const capabilities: Array<TrackerCapability> = ['children'];
  const { addComment, editBody, editComment, editLabels, listComments } = client;
  if (addComment !== undefined && listComments !== undefined) {
    capabilities.push('comment');
  }
  if (editBody !== undefined) {
    capabilities.push('checklist');
  }
  if (editLabels !== undefined) {
    capabilities.push('status');
  }
  if (listBlockedBy !== undefined) {
    capabilities.push('blockedBy');
  }
  if (listIssues !== undefined && config !== null) {
    capabilities.push('backlog');
  }
  const { issueLinks } = client;
  if (issueLinks !== undefined) {
    capabilities.push('related');
  }
  return {
    blockedBy: async (issue) => {
      if (listBlockedBy === undefined) {
        throw new UnsupportedOperation('github', 'blocking links');
      }
      const at = locate(issue);
      // GitHub keeps the link after the blocker closes; only an open one blocks.
      return (await listBlockedBy(at))
        .filter((related) => related.state === 'open')
        .map((related) => linkOf(at.owner, at.repo, related));
    },
    capabilities: new Set(capabilities),
    // GitHub keeps an issue's checklist as Markdown boxes in its body.
    checklistItems: async (issue) => {
      const at = locate(issue);
      return markdownChecklist(
        (await client.fetchIssue({ ...at, host: hostOf(issue, config?.host ?? 'github.com') }))
          .body,
      );
    },
    children: async (issue) => {
      const at = locate(issue);
      return (await client.listSubIssues(at)).map((related) => linkOf(at.owner, at.repo, related));
    },
    comment: async (issue, markdown, key, mode) => {
      if (addComment === undefined || listComments === undefined) {
        throw new UnsupportedOperation('github', 'comments');
      }
      const at = locate(issue);
      // A hidden marker in the comment body finds the comment of a key again.
      const marker = `<!-- factory:${key} -->`;
      const body = `${markdown}\n\n${marker}`;
      const posted = (await listComments(at)).find((item) => item.body.includes(marker));
      if (posted === undefined) {
        await addComment(at, body);
      } else if (mode === 'replace' && posted.body !== body) {
        if (editComment === undefined) {
          throw new UnsupportedOperation('github', 'editing comments');
        }
        await editComment(at, posted.id, body);
      }
    },
    kind: 'github',
    listBacklog: async () => {
      if (listIssues === undefined || config === null) {
        throw new UnsupportedOperation(
          'github',
          'a backlog without tracker.owner and tracker.repo',
        );
      }
      return (
        await listIssues({
          ...config.backlog,
          host: config.host,
          owner: config.owner,
          repo: config.repo,
        })
      ).map((issue) => trackerIssue(issue, `${issue.owner}/${issue.repo}#${issue.number}`));
    },
    refHint: 'a GitHub URL, owner/repo#number, or #number',
    related: async (issue, room) => {
      if (issueLinks === undefined) {
        throw new UnsupportedOperation('github', 'linked issues');
      }
      return relatedOf(
        client,
        issueLinks,
        issue,
        hostOf(issue, config?.host ?? 'github.com'),
        room,
      );
    },
    resolve: async (ref): Promise<Resolved | null> => {
      const target = githubTarget(ref, config);
      if (target === null) {
        return null;
      }
      if ('kind' in target) {
        return target;
      }
      let issue: GithubIssue;
      try {
        issue = await client.fetchIssue(target);
      } catch (error: unknown) {
        return { kind: 'error', message: messageOf(error), reason: 'tracker_unavailable' };
      }
      return { issue: trackerIssue(issue, ref), kind: 'issue' };
    },
    setStatus: async (issue, status) => {
      if (editLabels === undefined) {
        throw new UnsupportedOperation('github', 'status labels');
      }
      const mapped = config?.status ?? {};
      const labels = Object.values(mapped).map((item) => item.label);
      const add = status === 'clear' ? undefined : mapped[status]?.label;
      const remove = labels.filter((label) => label !== add);
      if (add === undefined && (status !== 'clear' || remove.length === 0)) {
        return null;
      }
      await editLabels(locate(issue), add === undefined ? [] : [add], remove);
      return null;
    },
    tickBoxes: async (issue, keys) => {
      if (editBody === undefined) {
        throw new UnsupportedOperation('github', 'ticking checkboxes');
      }
      const at = locate(issue);
      // The body as it is now: people may have edited it since it was read.
      const current = (
        await client.fetchIssue({ ...at, host: hostOf(issue, config?.host ?? 'github.com') })
      ).body;
      const ticked = tickMarkdown(current, keys);
      if (ticked.body !== current) {
        await editBody(at, ticked.body);
      }
      return { conflicts: ticked.conflicts };
    },
  };
}
