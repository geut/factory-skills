// The tracker port: the factory's one way to read issues. Each tracker (GitHub
// Issues first, Linear or Jira later) is an adapter that translates these
// operations into its own API and says which ones it can do. An operation an
// adapter cannot do throws UnsupportedOperation; asking for one in FACTORY.json
// stops the server at startup instead.

export type TrackerCapability = 'backlog' | 'blockedBy' | 'children' | 'comment' | 'status';

// A factory status shown on an issue, or `clear` to remove it.
export type IssueStatus = 'clear' | 'in_progress' | 'in_review';

// Which open issues the backlog shows; each tracker reads its own fields.
export type BacklogQuery = { labels: Array<string>; milestone: string | null };

// An issue as the factory sees it, whatever the tracker.
export type TrackerIssue = {
  // The tracker login of whoever opened it; null when the tracker does not say.
  author: string | null;
  body: string;
  // ISO times as the tracker reports them; null when it does not.
  createdAt: string | null;
  // `owner/repo#42` on GitHub, `ENG-42` on Linear: how people name it.
  displayRef: string;
  // Stable across renames and moves, such as `github:github.com:I_kw...`.
  id: string;
  labels: Array<string>;
  // The ref as the user gave it.
  ref: string;
  title: string;
  updatedAt: string | null;
  url: string;
};

// A linked issue: a sub-issue or an issue that blocks another.
export type IssueLink = { displayRef: string; title: string; url: string | null };

export type Resolved =
  | { issue: TrackerIssue; kind: 'issue' }
  | { kind: 'error'; message: string; reason?: 'tracker_unavailable' };

export type Tracker = {
  // Issues that block `issue`, through the tracker's native links.
  blockedBy: (issue: TrackerIssue) => Array<IssueLink>;
  capabilities: ReadonlySet<TrackerCapability>;
  // Sub-issues of `issue`, through the tracker's native links. An issue with
  // children is an umbrella and cannot be started.
  children: (issue: TrackerIssue) => Array<IssueLink>;
  // Comments on `issue` unless a comment carrying `marker` is already there,
  // so a retried update posts once.
  comment: (issue: TrackerIssue, markdown: string, marker: string) => void;
  // Also the ticket's source kind, such as `github`.
  kind: string;
  // Open issues matching the query, newest first.
  listBacklog: (query: BacklogQuery) => Array<TrackerIssue>;
  // Null when `ref` is not a ref this tracker understands.
  resolve: (ref: string) => Resolved | null;
  // Shows `status` on `issue` the way FACTORY.json maps it; unmapped is a no-op.
  setStatus: (issue: TrackerIssue, status: IssueStatus) => void;
};

export class UnsupportedOperation extends Error {
  constructor(tracker: string, operation: string) {
    super(`The ${tracker} tracker does not support ${operation}.`);
    this.name = 'UnsupportedOperation';
  }
}
