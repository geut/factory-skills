import type { FactorySnapshot, RunRecord } from '../../domain.ts';

// When `/factory retry --rebased` may carry the wrap-up pass over to a
// rebased branch, for the command before it reads git and for the reducer
// when it applies: the ticket waits in wrap-up, with nothing running.

// The current wrap-up pass: the session's runs from the latest that took a
// baseline. Wrap-up keeps its session across feedback rounds, so a round's
// pass starts at its own run, not the first round's.
function passRuns(snapshot: FactorySnapshot): Array<RunRecord> {
  const session = snapshot.sessions.find((item) => item.stage === 'wrapup') ?? null;
  if (session === null) {
    return [];
  }
  const runs = snapshot.runs.filter((run) => run.sessionId === session.id);
  const start = runs.findLastIndex((run) => run.baseline !== null);
  return start === -1 ? [] : runs.slice(start);
}

// The current pass's latest finished run: the one validation checks, and
// where the carried baseline goes. Null when the pass has none, as when its
// first run asked a question: an earlier round's handoff is never it.
export function latestPassRun(snapshot: FactorySnapshot): RunRecord | null {
  return passRuns(snapshot).findLast((run) => run.terminalKind === 'subagent_done') ?? null;
}

// The baseline the pass's validation reads.
export function passBaselineText(snapshot: FactorySnapshot): string | null {
  return passRuns(snapshot)[0]?.baseline ?? null;
}

// Why the pass cannot be carried over now, or null when it can.
export function rebasedRefusal(snapshot: FactorySnapshot): string | null {
  const { execution, ticket } = snapshot;
  const ref = ticket.displayRef;
  // A wrap-up agent that asked a question is idle too: carrying the pass over
  // answers it, and validates the pass instead.
  if (
    execution.stage !== 'wrapup' ||
    (execution.status !== 'paused' &&
      execution.status !== 'failed' &&
      execution.status !== 'waiting_for_user')
  ) {
    return `${ref} is ${execution.stage}/${execution.status}; --rebased carries over a wrap-up pass that is paused, failed, or waiting for you.`;
  }
  if (snapshot.runs.some((run) => run.status !== 'terminal')) {
    return `${ref} has an agent running; stop it first.`;
  }
  if (
    snapshot.actions.some((action) => action.status === 'pending' || action.status === 'leased')
  ) {
    return `${ref} has work in flight; wait for it to finish.`;
  }
  if (passBaselineText(snapshot) === null) {
    return `${ref} has no wrap-up pass to carry over.`;
  }
  if (latestPassRun(snapshot) === null) {
    return `${ref}'s wrap-up pass has no finished run to validate; reply to the agent instead.`;
  }
  return null;
}
