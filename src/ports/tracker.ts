// The tracker port: the factory's one way to read issues. Each tracker (GitHub
// Issues first, Linear or Jira later) is an adapter that translates these
// operations into its own API and says which ones it can do. Every operation
// that reaches the tracker is async. An operation an adapter cannot do rejects
// with UnsupportedOperation; asking for one in FACTORY.json stops the server at
// startup instead.

export type TrackerCapability =
  | 'backlog'
  | 'blockedBy'
  | 'checklist'
  | 'children'
  | 'comment'
  | 'status';

// A factory status shown on an issue, or `clear` to remove it.
export type IssueStatus = 'clear' | 'in_progress' | 'in_review';

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

// A backlog issue. An adapter that reads an issue's links along with the
// backlog includes them, so the backlog needs no call per issue; without them
// the factory asks blockedBy and children for each.
export type BacklogIssue = TrackerIssue & {
  links?: { blockedBy: Array<IssueLink>; children: Array<IssueLink> };
};

// One item of an issue's checklist, however the tracker keeps it: a Markdown
// box in the body, a checklist field, or a sub-issue. The key is the adapter's
// and means nothing to the factory but the item.
export type ChecklistItem = { done: boolean; key: string; text: string };

// A linked issue: a sub-issue or an issue that blocks another.
export type IssueLink = { displayRef: string; title: string; url: string | null };

export type Resolved =
  | { issue: TrackerIssue; kind: 'issue' }
  | { kind: 'error'; message: string; reason?: 'tracker_unavailable' };

export type Tracker = {
  // Issues that block `issue`, through the tracker's native links.
  blockedBy: (issue: TrackerIssue) => Promise<Array<IssueLink>>;
  capabilities: ReadonlySet<TrackerCapability>;
  // The issue's checklist as it is now, in order.
  checklistItems: (issue: TrackerIssue) => Promise<Array<ChecklistItem>>;
  // Sub-issues of `issue`, through the tracker's native links. An issue with
  // children is an umbrella and cannot be started.
  children: (issue: TrackerIssue) => Promise<Array<IssueLink>>;
  // Comments on `issue` unless the comment of `key` is already there, so a
  // retried update posts once. With `replace`, that comment's text is
  // replaced instead, so the issue keeps one up-to-date comment. How the
  // adapter finds the comment of a key is its own.
  comment: (
    issue: TrackerIssue,
    markdown: string,
    key: string,
    mode: 'once' | 'replace',
  ) => Promise<void>;
  // Also the ticket's source kind, such as `github`.
  kind: string;
  // The open issues the tracker's backlog settings in FACTORY.json select,
  // newest first.
  listBacklog: () => Promise<Array<BacklogIssue>>;
  // The refs this tracker understands, for a message about one it does not,
  // such as `a Linear issue key such as ENG-42, or its URL`.
  refHint: string;
  // Null when `ref` is not a ref this tracker understands.
  resolve: (ref: string) => Promise<Resolved | null>;
  // Shows `status` on `issue` the way FACTORY.json maps it; unmapped is a
  // no-op. Resolves to why the status was left as it is when a person should
  // know, such as a mapped state the issue's team does not have; else null.
  setStatus: (issue: TrackerIssue, status: IssueStatus) => Promise<string | null>;
  // Ticks the checklist items of these keys and changes nothing else. A key
  // the issue no longer has, because someone edited it, is a conflict.
  tickBoxes: (issue: TrackerIssue, keys: Array<string>) => Promise<{ conflicts: Array<string> }>;
};

export class UnsupportedOperation extends Error {
  constructor(tracker: string, operation: string) {
    super(`The ${tracker} tracker does not support ${operation}.`);
    this.name = 'UnsupportedOperation';
  }
}
