import type { DatabaseSync } from 'node:sqlite';

// Facts factory stats are computed from. Sync and webhooks write pull request
// facts here, keyed by the code host's own ids, so either can arrive first or
// twice.

export type FactoryIdentity = { createdAt: string; factoryId: string };

export function factoryIdentity(db: DatabaseSync): FactoryIdentity {
  const found = db.prepare('SELECT factory_id, created_at FROM factory_identity').get();
  return {
    createdAt: String(found?.['created_at'] ?? ''),
    factoryId: String(found?.['factory_id'] ?? ''),
  };
}

export type PullRequestState = 'closed' | 'merged' | 'open';

export type PullRequestFact = {
  author: string | null;
  closedAt: string | null;
  executionId: string;
  headBranch: string | null;
  mergedAt: string | null;
  number: number | null;
  openedAt: string | null;
  state: PullRequestState;
  url: string;
};

export function recordPullRequest(db: DatabaseSync, fact: PullRequestFact, now: string): void {
  db.prepare(
    `INSERT INTO pull_requests
      (execution_id, url, number, head_branch, author, state, opened_at, merged_at, closed_at,
       recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (execution_id) DO UPDATE SET
       url = excluded.url,
       number = coalesce(excluded.number, number),
       head_branch = coalesce(excluded.head_branch, head_branch),
       author = coalesce(excluded.author, author),
       state = excluded.state,
       opened_at = coalesce(excluded.opened_at, opened_at),
       merged_at = coalesce(excluded.merged_at, merged_at),
       closed_at = coalesce(excluded.closed_at, closed_at)`,
  ).run(
    fact.executionId,
    fact.url,
    fact.number,
    fact.headBranch,
    fact.author,
    fact.state,
    fact.openedAt,
    fact.mergedAt,
    fact.closedAt,
    now,
  );
}

export function markPullRequestSynced(db: DatabaseSync, executionId: string, now: string): void {
  db.prepare('UPDATE pull_requests SET last_synced_at = ? WHERE execution_id = ?').run(
    now,
    executionId,
  );
}

export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';

export type ReviewFact = {
  author: string;
  authorType: 'bot' | 'human';
  commitSha: string | null;
  executionId: string;
  hasBody: boolean;
  reviewId: string;
  state: ReviewState;
  submittedAt: string | null;
};

export function recordReview(db: DatabaseSync, fact: ReviewFact): void {
  db.prepare(
    `INSERT INTO pull_request_reviews
      (review_id, execution_id, author, author_type, state, has_body, commit_sha, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (review_id) DO UPDATE SET
       state = excluded.state, has_body = excluded.has_body,
       commit_sha = coalesce(excluded.commit_sha, commit_sha),
       submitted_at = coalesce(excluded.submitted_at, submitted_at)`,
  ).run(
    fact.reviewId,
    fact.executionId,
    fact.author,
    fact.authorType,
    fact.state,
    fact.hasBody ? 1 : 0,
    fact.commitSha,
    fact.submittedAt,
  );
}

export function recordCommit(
  db: DatabaseSync,
  fact: { committedAt: string | null; executionId: string; sha: string },
): void {
  db.prepare(
    `INSERT INTO pull_request_commits (execution_id, sha, committed_at) VALUES (?, ?, ?)
     ON CONFLICT (execution_id, sha) DO UPDATE SET
       committed_at = coalesce(excluded.committed_at, committed_at)`,
  ).run(fact.executionId, fact.sha, fact.committedAt);
}
