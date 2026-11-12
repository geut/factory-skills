import { z } from 'zod';

// The feedback on an open pull request that a feedback round can address: its
// unresolved review threads, its review bodies, and its conversation comments,
// from reviewers whose word counts. A comment is pending until a round takes
// it or the operator dismisses it, so nothing posted during a round is lost and
// nothing a round already took comes back. What does not count is listed as
// skipped, so a round can say what it left out.

// One comment as the round shows it. `id` is GitHub's database id, the same
// number its link ends with.
export type FeedbackComment = {
  author: string;
  body: string;
  createdAt: string;
  id: string;
  url: string | null;
};

// What every item carries: how the operator names it, such as `r2841` or
// `c6799`, and the ids of the comments it holds, which a round records.
type Pending = { commentIds: Array<string>; ref: string };

export type FeedbackItem =
  // An unresolved review thread, whole, so the worker reads its context.
  | (Pending & {
      comments: Array<FeedbackComment>;
      kind: 'thread';
      line: number | null;
      path: string;
      // GitHub's node id, for replying in the thread.
      threadId: string;
    })
  | (Pending & FeedbackComment & { kind: 'review'; state: string })
  | (Pending & FeedbackComment & { kind: 'comment' });

export type SkippedFeedback = {
  author: string;
  id: string;
  kind: FeedbackItem['kind'];
  url: string | null;
};

export type PullRequestFeedback = {
  items: Array<FeedbackItem>;
  skipped: Array<SkippedFeedback>;
  // Whether a list was longer than one page, so its oldest items were not read.
  truncated: boolean;
};

// The newest items of each list: GitHub orders them oldest first.
const PAGE = 100;

// One query reads all three lists for a pull request.
export const FEEDBACK_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(last: ${PAGE}) {
        pageInfo { hasPreviousPage }
        nodes {
          id
          isResolved
          path
          line
          originalLine
          comments(last: ${PAGE}) {
            pageInfo { hasPreviousPage }
            nodes { author { login } authorAssociation body createdAt databaseId url }
          }
        }
      }
      reviews(last: ${PAGE}) {
        pageInfo { hasPreviousPage }
        nodes { author { login } authorAssociation body databaseId state submittedAt url }
      }
      comments(last: ${PAGE}) {
        pageInfo { hasPreviousPage }
        nodes { author { login } authorAssociation body createdAt databaseId url }
      }
    }
  }
}`;

// A deleted account has no author.
const author = z.object({ login: z.string() }).nullable();
const pageInfo = z.object({ hasPreviousPage: z.boolean() });

const commentNode = z.object({
  author,
  authorAssociation: z.string(),
  body: z.string(),
  createdAt: z.string(),
  databaseId: z.number(),
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
              databaseId: z.number(),
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

// Sorts a pull request's feedback into what a round can take and what it
// skips. `seen` holds the comment ids earlier rounds took or the operator
// dismissed: a thread is pending while it has a counted comment not seen yet.
export function feedbackFrom(
  payload: unknown,
  options: { authors: ReadonlyArray<string>; seen: ReadonlySet<string> },
): PullRequestFeedback {
  const parsed = feedbackResponse.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Unexpected pull request feedback from GitHub: ${parsed.error.message}`);
  }
  const pull = parsed.data.data.repository.pullRequest;
  const unseen = (node: { databaseId: number }) => !options.seen.has(String(node.databaseId));
  const counts = (node: { author: { login: string } | null; authorAssociation: string }) =>
    countsAsReviewer(
      { association: node.authorAssociation, author: authorOf(node) },
      options.authors,
    );
  const skip = (
    node: { author: { login: string } | null; databaseId: number; url: string | null },
    kind: FeedbackItem['kind'],
  ): SkippedFeedback => ({
    author: authorOf(node),
    id: String(node.databaseId),
    kind,
    url: node.url,
  });
  const items: Array<FeedbackItem> = [];
  const skipped: Array<SkippedFeedback> = [];
  for (const thread of pull.reviewThreads.nodes) {
    const first = thread.comments.nodes[0];
    if (thread.isResolved || first === undefined) {
      continue;
    }
    const fresh = thread.comments.nodes.filter((node) => unseen(node) && !own(node.body));
    skipped.push(...fresh.filter((node) => !counts(node)).map((node) => skip(node, 'thread')));
    if (!fresh.some((node) => counts(node))) {
      continue;
    }
    const counted = thread.comments.nodes.filter((node) => !own(node.body) && counts(node));
    items.push({
      commentIds: counted.map((node) => String(node.databaseId)),
      comments: counted.map((node) => ({
        author: authorOf(node),
        body: node.body,
        createdAt: node.createdAt,
        id: String(node.databaseId),
        url: node.url,
      })),
      kind: 'thread',
      line: thread.line ?? thread.originalLine,
      path: thread.path,
      ref: `r${first.databaseId}`,
      threadId: thread.id,
    });
  }
  for (const review of pull.reviews.nodes) {
    if (review.body.trim().length === 0 || !unseen(review) || own(review.body)) {
      continue;
    }
    if (!counts(review)) {
      skipped.push(skip(review, 'review'));
      continue;
    }
    items.push({
      author: authorOf(review),
      body: review.body,
      commentIds: [String(review.databaseId)],
      createdAt: review.submittedAt ?? '',
      id: String(review.databaseId),
      kind: 'review',
      ref: `p${review.databaseId}`,
      state: review.state.toLowerCase(),
      url: review.url,
    });
  }
  for (const comment of pull.comments.nodes) {
    if (!unseen(comment) || own(comment.body)) {
      continue;
    }
    if (!counts(comment)) {
      skipped.push(skip(comment, 'comment'));
      continue;
    }
    items.push({
      author: authorOf(comment),
      body: comment.body,
      commentIds: [String(comment.databaseId)],
      createdAt: comment.createdAt,
      id: String(comment.databaseId),
      kind: 'comment',
      ref: `c${comment.databaseId}`,
      url: comment.url,
    });
  }
  const truncated =
    pull.reviewThreads.pageInfo.hasPreviousPage ||
    pull.reviews.pageInfo.hasPreviousPage ||
    pull.comments.pageInfo.hasPreviousPage ||
    pull.reviewThreads.nodes.some((thread) => thread.comments.pageInfo.hasPreviousPage);
  return { items, skipped, truncated };
}
