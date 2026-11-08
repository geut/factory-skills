import { DEFAULT_TRACKER_UPDATES, type TrackerUpdates } from '../config.ts';
import type { ActionRecord, TicketRecord } from '../domain.ts';
import type { Tracker, TrackerIssue } from '../ports/tracker.ts';

type TicketUpdate = Pick<
  Extract<ActionRecord, { kind: 'update_ticket_source' }>,
  'checklist' | 'comment' | 'commentKey' | 'idempotencyKey' | 'issueStatus'
>;

// The ticket's issue, as the tracker port takes it.
export function trackerIssueOf(ticket: TicketRecord): TrackerIssue {
  return {
    author: null,
    body: ticket.body,
    createdAt: null,
    displayRef: ticket.displayRef,
    id: ticket.id,
    labels: ticket.labels,
    ref: ticket.commandRef,
    title: ticket.title,
    updatedAt: null,
    url: ticket.sourceRef,
  };
}

// Writes one tracker update to the issue: ticks its checklist items, posts or
// replaces its comment, and shows its status, as far as the tracker can and
// FACTORY.json's tracker.updates allows. Returns the item texts it left
// unticked because someone changed them on the issue, and why the status was
// left as it was, when a person should know.
export async function applyTicketUpdate(
  tracker: Tracker,
  issue: TrackerIssue,
  update: TicketUpdate,
  updates: TrackerUpdates = DEFAULT_TRACKER_UPDATES,
): Promise<{ conflicts: Array<string>; statusNote: string | null }> {
  const textOf = new Map(update.checklist.map((item) => [item.key, item.text]));
  let conflicts: Array<string> = [];
  // A failed edit still lets the comment and status through; it is thrown
  // after them, so a retry ticks again and replaces the comment.
  let failed: unknown = null;
  const ticking = updates.checklist && tracker.capabilities.has('checklist');
  if (update.checklist.length > 0 && ticking) {
    try {
      conflicts = (
        await tracker.tickBoxes(
          issue,
          update.checklist.map((item) => item.key),
        )
      ).conflicts.map((key) => textOf.get(key) ?? key);
    } catch (error: unknown) {
      failed = error;
    }
  }
  if (updates.comments && tracker.capabilities.has('comment')) {
    // The met items go in the comment when they were not ticked on the issue:
    // ticking is off, or it failed.
    const metHeading =
      failed !== null
        ? 'Met (ticking them on the issue failed):'
        : updates.checklist
          ? null
          : 'Met:';
    const markdown = [
      update.comment,
      ...(metHeading === null || update.checklist.length === 0
        ? []
        : ['', metHeading, ...update.checklist.map((item) => `- [x] ${item.text}`)]),
      ...(conflicts.length === 0
        ? []
        : [
            '',
            'Not ticked, because the item changed on the issue:',
            ...conflicts.map((text) => `- ${text}`),
          ]),
    ].join('\n');
    // Without a key of its own, the action's key makes a retried comment a
    // no-op, even after a crash.
    await tracker.comment(
      issue,
      markdown,
      update.commentKey ?? update.idempotencyKey,
      update.commentKey === null ? 'once' : 'replace',
    );
  }
  let statusNote: string | null = null;
  if (update.issueStatus !== null && tracker.capabilities.has('status')) {
    statusNote = await tracker.setStatus(issue, update.issueStatus);
  }
  if (failed !== null) {
    throw failed;
  }
  return { conflicts, statusNote };
}
