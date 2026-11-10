import { z } from 'zod';

// The feedback on an open pull request that a feedback round addresses: its
// unresolved review threads, its review bodies, and its conversation comments,
// each from a reviewer whose word counts, and posted since the factory's last
// push. Everything else that was posted since is listed as skipped, so the
// round can say what it left out.

// One comment as the round shows it.
export type FeedbackComment = {
  author: string;
  body: string;
  createdAt: string;
  url: string | null;
};

export type FeedbackItem =
  // An unresolved review thread, whole, so the worker reads its context.
  | {
      comments: Array<FeedbackComment>;
      kind: 'thread';
      line: number | null;
      path: string;
      // GitHub's node id, for replying in the thread.
      threadId: string;
    }
  | (FeedbackComment & { kind: 'review'; state: string })
  | (FeedbackComment & { kind: 'comment' });

export type SkippedFeedback = {
  author: string;
  kind: FeedbackItem['kind'];
  url: string | null;
};

export type PullRequestFeedback = {
  items: Array<FeedbackItem>;
  skipped: Array<SkippedFeedback>;
  // Whether a list was longer than one page, so some feedback was not read.
  truncated: boolean;
};

const PAGE = 100;

// One query reads all three lists for a pull request.
export const FEEDBACK_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: ${PAGE}) {
        pageInfo { hasNextPage }
        nodes {
          id
          isResolved
          path
          line
          originalLine
          comments(first: ${PAGE}) {
            pageInfo { hasNextPage }
            nodes { author { login } authorAssociation body createdAt url }
          }
        }
      }
      reviews(first: ${PAGE}) {
        pageInfo { hasNextPage }
        nodes { author { login } authorAssociation body state submittedAt url }
      }
      comments(first: ${PAGE}) {
        pageInfo { hasNextPage }
        nodes { author { login } authorAssociation body createdAt url }
      }
    }
  }
}`;

// A deleted account has no author.
const author = z.object({ login: z.string() }).nullable();
const pageInfo = z.object({ hasNextPage: z.boolean() });

const commentNode = z.object({
  author,
  authorAssociation: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string().nullable(),
});

const feedbackResponse = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        comments: z.object({ nodes: z.array(commentNode), pageInfo }),
        reviews: z.object({
          nodes: z.array(
            z.object({
              author,
              authorAssociation: z.string(),
              body: z.string(),
              state: z.string(),
              submittedAt: z.string().nullable(),
              url: z.string().nullable(),
            }),
          ),
          pageInfo,
        }),
        reviewThreads: z.object({
          nodes: z.array(
            z.object({
              comments: z.object({ nodes: z.array(commentNode), pageInfo }),
              id: z.string(),
              isResolved: z.boolean(),
              line: z.number().nullable(),
              originalLine: z.number().nullable(),
              path: z.string(),
            }),
          ),
          pageInfo,
        }),
      }),
    }),
  }),
});

// The factory's own comments carry this marker, so a round never answers itself.
export const FACTORY_MARKER = '<!-- factory:';

// Associations GitHub gives the people who can collaborate on the repository.
const COLLABORATORS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// A bot's login is `coderabbitai` in GraphQL and `coderabbitai[bot]` in REST.
function loginKey(login: string): string {
  return login.replace(/\[bot\]$/i, '').toLowerCase();
}

// Whose word counts: a collaborator, or an author `authors` names, such as a
// review bot, which GitHub never reports as a collaborator.
export function countsAsReviewer(
  comment: { association: string; author: string },
  authors: ReadonlyArray<string>,
): boolean {
  return (
    COLLABORATORS.has(comment.association) ||
    authors.some((listed) => loginKey(listed) === loginKey(comment.author))
  );
}

// Whether a comment is one the factory posted.
function own(body: string): boolean {
  return body.includes(FACTORY_MARKER);
}

function authorOf(node: { author: { login: string } | null }): string {
  return node.author?.login ?? 'ghost';
}

// Sorts a pull request's feedback into what the round addresses and what it
// skips. Only what was posted after `since`, the factory's last push, is new.
export function feedbackFrom(
  payload: unknown,
  options: { authors: ReadonlyArray<string>; since: string },
): PullRequestFeedback {
  const parsed = feedbackResponse.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Unexpected pull request feedback from GitHub: ${parsed.error.message}`);
  }
  const pull = parsed.data.data.repository.pullRequest;
  const since = Date.parse(options.since);
  const isNew = (at: string | null) => at !== null && Date.parse(at) > since;
  const counts = (node: { author: { login: string } | null; authorAssociation: string }) =>
    countsAsReviewer(
      { association: node.authorAssociation, author: authorOf(node) },
      options.authors,
    );
  const items: Array<FeedbackItem> = [];
  const skipped: Array<SkippedFeedback> = [];
  for (const thread of pull.reviewThreads.nodes) {
    if (thread.isResolved) {
      continue;
    }
    const fresh = thread.comments.nodes.filter((node) => isNew(node.createdAt) && !own(node.body));
    if (fresh.length === 0) {
      continue;
    }
    const counted = fresh.filter((node) => counts(node));
    if (counted.length === 0) {
      skipped.push(
        ...fresh.map((node) => ({
          author: authorOf(node),
          kind: 'thread' as const,
          url: node.url,
        })),
      );
      continue;
    }
    items.push({
      comments: thread.comments.nodes
        .filter((node) => !own(node.body) && counts(node))
        .map((node) => ({
          author: authorOf(node),
          body: node.body,
          createdAt: node.createdAt,
          url: node.url,
        })),
      kind: 'thread',
      line: thread.line ?? thread.originalLine,
      path: thread.path,
      threadId: thread.id,
    });
  }
  for (const review of pull.reviews.nodes) {
    if (review.body.trim().length === 0 || !isNew(review.submittedAt) || own(review.body)) {
      continue;
    }
    if (!counts(review)) {
      skipped.push({ author: authorOf(review), kind: 'review', url: review.url });
      continue;
    }
    items.push({
      author: authorOf(review),
      body: review.body,
      createdAt: review.submittedAt ?? '',
      kind: 'review',
      state: review.state.toLowerCase(),
      url: review.url,
    });
  }
  for (const comment of pull.comments.nodes) {
    if (!isNew(comment.createdAt) || own(comment.body)) {
      continue;
    }
    if (!counts(comment)) {
      skipped.push({ author: authorOf(comment), kind: 'comment', url: comment.url });
      continue;
    }
    items.push({
      author: authorOf(comment),
      body: comment.body,
      createdAt: comment.createdAt,
      kind: 'comment',
      url: comment.url,
    });
  }
  const truncated =
    pull.reviewThreads.pageInfo.hasNextPage ||
    pull.reviews.pageInfo.hasNextPage ||
    pull.comments.pageInfo.hasNextPage ||
    pull.reviewThreads.nodes.some((thread) => thread.comments.pageInfo.hasNextPage);
  return { items, skipped, truncated };
}
