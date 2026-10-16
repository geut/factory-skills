import { existsSync } from 'node:fs';
import path from 'node:path';
import { factoryPaths } from '../controller/service.ts';
import {
  listCurrentTicketRefs,
  loadCurrentByFactoryKey,
  loadCurrentByTicketKey,
  ticketKeyOf,
} from '../controller/store.ts';
import type { FactorySnapshot } from '../domain.ts';
import { openStateDatabase, stateDatabasePath } from '../state/database.ts';

export const sessionsUsage = `Usage:
  factory sessions [ticket]   list each stage's Pi session file

Lists the sessions of every current ticket, or of one ticket named by its
reference or key. Open a session with \`pi --session <file>\`.`;

type Io = { err: (line: string) => void; out: (line: string) => void };

// One line per session: stage and task, how its last run ended, its file.
export function sessionLines(snapshot: FactorySnapshot, cwd: string): Array<string> {
  const lines = [`${snapshot.ticket.displayRef}  (${ticketKeyOf(snapshot)})`];
  if (snapshot.sessions.length === 0) {
    lines.push('  no sessions yet');
    return lines;
  }
  const rows = snapshot.sessions.map((session) => {
    const runs = snapshot.runs.filter((run) => run.sessionId === session.id);
    const last = runs.at(-1) ?? null;
    const state = last === null ? session.status : (last.terminalKind ?? last.status);
    const file =
      session.sessionFile === null ? '(not started)' : path.relative(cwd, session.sessionFile);
    return [
      session.taskId === null ? session.stage : `${session.stage} ${session.taskId}`,
      state,
      file,
    ];
  });
  const widths = [0, 1].map((column) => Math.max(...rows.map((row) => row[column]?.length ?? 0)));
  for (const [name = '', state = '', file = ''] of rows) {
    lines.push(`  ${name.padEnd(widths[0] ?? 0)}  ${state.padEnd(widths[1] ?? 0)}  ${file}`);
  }
  return lines;
}

export function runSessionsCommand(args: Array<string>, cwd: string, io: Io): number {
  const [ticket] = args;
  if (ticket === '--help') {
    io.err(sessionsUsage);
    return 0;
  }
  const { factoryRoot } = factoryPaths(cwd);
  if (!existsSync(factoryRoot)) {
    io.err(`No factory root at ${factoryRoot}. Run this from the repository root.`);
    return 1;
  }
  if (!existsSync(stateDatabasePath(factoryRoot))) {
    io.err('No tickets yet.');
    return 0;
  }
  const db = openStateDatabase(factoryRoot, { readOnly: true });
  try {
    const snapshots: Array<FactorySnapshot> = [];
    if (ticket === undefined) {
      for (const ref of listCurrentTicketRefs(db)) {
        const found = loadCurrentByTicketKey(db, ref);
        if (found !== null) {
          snapshots.push(found);
        }
      }
      if (snapshots.length === 0) {
        io.err('No tickets yet.');
        return 0;
      }
    } else {
      const found = loadCurrentByTicketKey(db, ticket) ?? loadCurrentByFactoryKey(db, ticket);
      if (found === null) {
        io.err(`No ticket ${ticket}.`);
        return 1;
      }
      snapshots.push(found);
    }
    for (const [index, snapshot] of snapshots.entries()) {
      if (index > 0) {
        io.out('');
      }
      for (const line of sessionLines(snapshot, cwd)) {
        io.out(line);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}
