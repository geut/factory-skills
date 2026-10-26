import type { ActionRecord } from '../domain.ts';
import type { Tracker, TrackerIssue } from '../ports/tracker.ts';

type TicketUpdate = Pick<
  Extract<ActionRecord, { kind: 'update_ticket_source' }>,
  'checklist' | 'comment' | 'commentMarker' | 'idempotencyKey' | 'issueStatus'
>;

// Writes one tracker update to the issue: ticks its boxes, posts or replaces
// its comment, and shows its status, as far as the tracker can. Returns the
// box texts it left unticked because someone changed them on the issue.
export function applyTicketUpdate(
  tracker: Tracker,
  issue: TrackerIssue,
  update: TicketUpdate,
): { conflicts: Array<string> } {
  const canTick = update.checklist.length > 0 && tracker.capabilities.has('checklist');
  let conflicts: Array<string> = [];
  // A failed edit still lets the comment and status through; it is thrown
  // after them, so a retry ticks again and replaces the comment.
  let failed: unknown = null;
  if (canTick) {
    try {
      ({ conflicts } = tracker.tickBoxes(issue, update.checklist));
    } catch (error: unknown) {
      failed = error;
    }
  }
  if (tracker.capabilities.has('comment')) {
    const unticked = canTick && failed === null ? [] : update.checklist;
    const markdown = [
      update.comment,
      ...(unticked.length === 0
        ? []
        : [
            '',
            failed === null
              ? 'Met (this tracker cannot tick the issue’s boxes):'
              : 'Met (ticking them on the issue failed):',
            ...unticked.map((text) => `- [x] ${text}`),
          ]),
      ...(conflicts.length === 0
        ? []
        : [
            '',
            'Not ticked, because the box changed on the issue:',
            ...conflicts.map((text) => `- ${text}`),
          ]),
    ].join('\n');
    // Without a marker of its own, the action's key makes a retried comment a
    // no-op, even after a crash.
    tracker.comment(
      issue,
      markdown,
      update.commentMarker ?? `<!-- factory:${update.idempotencyKey} -->`,
      update.commentMarker === null ? 'once' : 'replace',
    );
  }
  if (update.issueStatus !== null && tracker.capabilities.has('status')) {
    tracker.setStatus(issue, update.issueStatus);
  }
  if (failed !== null) {
    throw failed;
  }
  return { conflicts };
}
