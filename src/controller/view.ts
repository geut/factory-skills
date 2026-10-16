import type { DatabaseSync } from 'node:sqlite';
import type { FactorySnapshot, RunId } from '../domain.ts';
import { ticketProgress, type TicketProgress } from './progress.ts';
import { detail } from './reduce.ts';
import { runListLabel, runOutcome, runsInStartOrder, type RunOutcome } from './run-card.ts';
import {
  formatStatus,
  listCurrentTicketRefs,
  loadCurrentByFactoryKey,
  loadCurrentByTicketKey,
} from './store.ts';

// Read-only views of the controller state. The service and Pi both use them;
// none of them changes the database.

export type TicketRunRow = {
  label: string;
  outcome: RunOutcome;
  runId: RunId;
  sessionFile: string | null;
};

export type TicketDetail = {
  displayRef: string;
  progress: TicketProgress | null;
  runs: Array<TicketRunRow>;
};

export function ticketDetailOf(snapshot: FactorySnapshot): TicketDetail {
  return {
    displayRef: snapshot.ticket.displayRef,
    progress: ticketProgress(snapshot),
    runs: runsInStartOrder(snapshot.runs).map((run) => {
      const session = snapshot.sessions.find((item) => item.id === run.sessionId) ?? null;
      return {
        label: runListLabel(snapshot, run),
        outcome: runOutcome(snapshot, run),
        runId: run.id,
        sessionFile: session?.sessionFile ?? null,
      };
    }),
  };
}

// A ticket by any of its refs, or by its API key.
export function findTicket(db: DatabaseSync, ref: string): FactorySnapshot | null {
  return loadCurrentByTicketKey(db, ref) ?? loadCurrentByFactoryKey(db, ref);
}

// Progress of every current ticket that is not finished.
export function progressOf(db: DatabaseSync): Array<TicketProgress> {
  return listCurrentTicketRefs(db).flatMap((ref) => {
    const snapshot = loadCurrentByTicketKey(db, ref);
    return snapshot === null || snapshot.execution.stage === 'done'
      ? []
      : [ticketProgress(snapshot)];
  });
}

export function statusOf(db: DatabaseSync, ref: string): string {
  const snapshot = findTicket(db, ref);
  if (snapshot === null) {
    return `No factory execution matches ${ref}.`;
  }
  return formatStatus(
    detail(
      snapshot,
      snapshot.execution.message ?? `${snapshot.execution.stage}/${snapshot.execution.status}`,
    ),
  );
}

// With no ref, the only ticket in progress.
export function ticketDetailFor(db: DatabaseSync, ref: string | null): TicketDetail | string {
  let key = ref ?? '';
  if (key.length === 0) {
    const refs = listCurrentTicketRefs(db);
    if (refs.length === 0) {
      return 'No factory ticket is in progress.';
    }
    if (refs.length > 1) {
      return `Name a ticket: ${refs.join(', ')}`;
    }
    key = refs[0] ?? '';
  }
  const snapshot = findTicket(db, key);
  if (snapshot === null) {
    return `No factory execution matches ${key}.`;
  }
  return ticketDetailOf(snapshot);
}
