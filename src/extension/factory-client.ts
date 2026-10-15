import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { ParsedCommand } from '../controller/parse.ts';
import type { TicketProgress } from '../controller/progress.ts';
import {
  cardsSince,
  latestRevision,
  listRunningChildren,
  ticketKeyOf,
  type RunningChildRow,
} from '../controller/store.ts';
import {
  findTicket,
  progressOf,
  statusOf,
  ticketDetailFor,
  type TicketDetail,
} from '../controller/view.ts';
import { localTokenPath } from '../server/clients.ts';
import { leaseIsLive, readServerLease } from '../server/lease.ts';
import { openStateDatabase, stateDatabasePath } from '../state/database.ts';

// Pi's side of the factory. It reads the database directly for everything it
// shows and sends commands to the factory server; it never runs the
// controller, so any number of Pi sessions can watch one factory.

export type FactoryClient = {
  cardsSince: (revision: number) => Array<{ card: string; revision: number }>;
  close: () => void;
  command: (command: ParsedCommand) => Promise<string>;
  progress: () => Array<TicketProgress>;
  revision: () => number;
  runningChildren: () => Array<RunningChildRow>;
  status: (ref: string) => string;
  ticketDetail: (ref: string | null) => TicketDetail | string;
};

type Problem = { detail?: string; title?: string };

export function noServerMessage(factoryRoot: string): string {
  return `No factory server is running for ${factoryRoot}. Start it with \`factory serve\` in a Herdr pane.`;
}

// Reply, retry, and complete name a ticket by its API key.
function keyFor(open: DatabaseSync, ref: string): string | null {
  const snapshot = findTicket(open, ref);
  return snapshot === null ? null : ticketKeyOf(snapshot);
}

export function createFactoryClient(input: {
  factoryRoot: string;
  fetch?: typeof fetch;
  now?: () => string;
}): FactoryClient {
  const send = input.fetch ?? fetch;
  const now = input.now ?? (() => new Date().toISOString());
  let db: DatabaseSync | null = null;
  let openError: string | null = null;

  // The database appears with the first server start, so keep trying.
  function database(): DatabaseSync | null {
    if (db !== null) {
      return db;
    }
    if (!existsSync(stateDatabasePath(input.factoryRoot))) {
      // No server has started here yet.
      openError = null;
      return null;
    }
    try {
      db = openStateDatabase(input.factoryRoot, { readOnly: true });
      openError = null;
    } catch (error: unknown) {
      openError = error instanceof Error ? error.message : String(error);
    }
    return db;
  }

  function unavailable(): string {
    return openError ?? noServerMessage(input.factoryRoot);
  }

  function serverUrl(open: DatabaseSync): string | null {
    const lease = readServerLease(open);
    return lease !== null && leaseIsLive(lease, now()) ? lease.url : null;
  }

  async function post(
    url: string,
    route: string,
    body: unknown,
  ): Promise<{ problem: string } | { ticket: string }> {
    let token: string;
    try {
      token = readFileSync(localTokenPath(input.factoryRoot), 'utf8').trim();
    } catch {
      return { problem: `Cannot read ${localTokenPath(input.factoryRoot)}; restart the server.` };
    }
    let response: Response;
    try {
      response = await send(`${url}${route}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        method: 'POST',
      });
    } catch (error: unknown) {
      return {
        problem: `Cannot reach the factory server at ${url}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const payload = (await response.json().catch(() => ({}))) as Problem & { ticket?: string };
    if (response.status === 202 && typeof payload.ticket === 'string') {
      return { ticket: payload.ticket };
    }
    return {
      problem: payload.detail ?? payload.title ?? `The server answered ${response.status}.`,
    };
  }

  async function command(parsed: ParsedCommand): Promise<string> {
    if (parsed.kind === 'invalid') {
      return parsed.message;
    }
    const open = database();
    if (open === null) {
      return unavailable();
    }
    if (parsed.kind === 'status') {
      return statusOf(open, parsed.ref);
    }
    if (parsed.kind === 'agents' || parsed.kind === 'ticket') {
      return '';
    }
    const url = serverUrl(open);
    if (url === null) {
      return noServerMessage(input.factoryRoot);
    }
    let sent;
    if (parsed.kind === 'start') {
      sent = await post(
        url,
        '/v1/tickets',
        parsed.source.kind === 'ref'
          ? { ref: parsed.source.value }
          : { id: parsed.source.id, text: parsed.source.body },
      );
    } else {
      const key = keyFor(open, parsed.ref);
      if (key === null) {
        return `No factory execution matches ${parsed.ref}.`;
      }
      sent =
        parsed.kind === 'reply'
          ? await post(url, `/v1/tickets/${key}/replies`, { answer: parsed.answer })
          : await post(
              url,
              `/v1/tickets/${key}/${parsed.kind === 'retry' ? 'retries' : 'complete'}`,
              undefined,
            );
    }
    return 'problem' in sent ? sent.problem : statusOf(open, sent.ticket);
  }

  return {
    cardsSince: (revision) => {
      const open = database();
      return open === null ? [] : cardsSince(open, revision);
    },
    close: () => {
      db?.close();
      db = null;
    },
    command,
    progress: () => {
      const open = database();
      return open === null ? [] : progressOf(open);
    },
    revision: () => {
      const open = database();
      return open === null ? 0 : latestRevision(open);
    },
    runningChildren: () => {
      const open = database();
      return open === null ? [] : listRunningChildren(open);
    },
    status: (ref) => {
      const open = database();
      return open === null ? unavailable() : statusOf(open, ref);
    },
    ticketDetail: (ref) => {
      const open = database();
      return open === null ? unavailable() : ticketDetailFor(open, ref);
    },
  };
}
