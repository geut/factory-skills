import type { FactorySnapshot, RunRecord } from '../../domain.ts';

// When `/factory retry --rebased` may carry the wrap-up pass over to a
// rebased branch, for the command before it reads git and for the reducer
// when it applies: the ticket waits in wrap-up, with nothing running.

// The wrap-up pass's latest finished run: the one validation checks, and
// where the carried baseline goes.
export function latestPassRun(snapshot: FactorySnapshot): RunRecord | null {
  const session = snapshot.sessions.find((item) => item.stage === 'wrapup') ?? null;
  return session === null
    ? null
    : (snapshot.runs.findLast(
        (run) => run.sessionId === session.id && run.terminalKind === 'subagent_done',
      ) ?? null);
}

// The baseline the pass's validation reads: the session's latest.
export function passBaselineText(snapshot: FactorySnapshot): string | null {
  const session = snapshot.sessions.find((item) => item.stage === 'wrapup') ?? null;
  return session === null
    ? null
    : (snapshot.runs.findLast((run) => run.sessionId === session.id && run.baseline !== null)
        ?.baseline ?? null);
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
  if (latestPassRun(snapshot) === null || passBaselineText(snapshot) === null) {
    return `${ref} has no wrap-up pass to carry over.`;
  }
  return null;
}
