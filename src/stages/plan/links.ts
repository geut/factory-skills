import type { LinkedIssue, Tracker, TrackerIssue } from '../../ports/tracker.ts';

// The ticket's linked issues for its plan: read once, when its worktree is
// ready, and kept with that event, so a correction or a resumed plan never
// reads them again.

export type PlanLinks =
  // No tracker that reads links for this ticket, or limits.linkedIssues is 0.
  | { kind: 'none' }
  | { issues: Array<LinkedIssue>; kind: 'read'; omitted: number }
  // The tracker failed; the plan goes on without them.
  | { kind: 'failed' };

// The links of `issue`, at most `limit`. A tracker that fails is logged and
// the plan goes on.
export async function readPlanLinks(input: {
  issue: TrackerIssue;
  limit: number;
  log: (line: string) => void;
  // The tracker the ticket came from, or null.
  tracker: Tracker | null;
}): Promise<PlanLinks> {
  const { tracker } = input;
  if (input.limit <= 0 || tracker === null || !tracker.capabilities.has('related')) {
    return { kind: 'none' };
  }
  let issues: Array<LinkedIssue>;
  try {
    issues = await tracker.related(input.issue);
  } catch (error: unknown) {
    input.log(
      `Could not read the linked issues of ${input.issue.displayRef}; planning without them: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { kind: 'failed' };
  }
  return {
    issues: issues.slice(0, input.limit),
    kind: 'read',
    omitted: Math.max(0, issues.length - input.limit),
  };
}

// `- blocked by BUG-1351 [In Review] Restrict the audit view · PR <url> · 4 comments`
function linkLine(link: LinkedIssue): string {
  const parts = [
    `- ${link.relation} ${link.displayRef}${link.state === null ? '' : ` [${link.state}]`} ${link.title}`,
  ];
  if (link.pullRequests.length > 0) {
    parts.push(`${link.pullRequests.length === 1 ? 'PR' : 'PRs'} ${link.pullRequests.join(' ')}`);
  }
  if (link.comments !== null && link.comments.count > 0) {
    parts.push(
      `${link.comments.count}${link.comments.more ? '+' : ''} comment${link.comments.count === 1 && !link.comments.more ? '' : 's'}`,
    );
  }
  return parts.join(' · ');
}

// The plan prompt's section, after the ticket body: one line per link, no
// descriptions or comments; empty when there is nothing to say.
export function linkedIssuesSection(links: PlanLinks): Array<string> {
  switch (links.kind) {
    case 'none':
      return [];
    case 'failed':
      return [
        '',
        'Linked issues: the tracker could not be read. If the ticket builds on other issues, look them up with the project’s tools.',
      ];
    case 'read':
      if (links.issues.length === 0) {
        return [];
      }
      return [
        '',
        'Linked issues (one level; read one with the project’s tools when it matters):',
        ...links.issues.map(linkLine),
        ...(links.omitted === 0
          ? []
          : [`- and ${links.omitted} more not listed (limits.linkedIssues).`]),
      ];
    default: {
      const _exhaustive: never = links;
      return _exhaustive;
    }
  }
}
