import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { latestRevision } from '../controller/store.ts';
import type { Actor } from '../domain.ts';

// The change feed behind GET /v1/events. One timer reads the events table
// after the oldest subscriber's cursor and hands each subscriber what is new
// to it, so every writer to the database shows up, whichever process it is.

export type FactoryEvent = {
  actor: Actor | null;
  // Posted status cards carry their text.
  card: string | null;
  kind: string;
  revision: number;
  run: string | null;
  task: string | null;
  ticket: string | null;
};

export type EventHub = {
  close: () => void;
  latest: () => number;
  // Calls `send` with every event after `since`, in order, until unsubscribed.
  subscribe: (since: number, send: (event: FactoryEvent) => void) => () => void;
};

const POLL_MS = 250;
const BATCH = 500;

type Subscriber = { cursor: number; send: (event: FactoryEvent) => void };

function cardOf(payload: unknown): string | null {
  if (typeof payload !== 'string') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === 'object' &&
      parsed !== null &&
      'card' in parsed &&
      typeof parsed.card === 'string'
      ? parsed.card
      : null;
  } catch {
    return null;
  }
}

export function readEvents(db: DatabaseSync, after: number, limit = BATCH): Array<FactoryEvent> {
  return db
    .prepare(
      `SELECT ev.revision, ev.kind, ev.task_id, ev.run_id, ev.actor, ev.actor_on_behalf_of,
              ev.payload_json, ex.factory_dir
       FROM events AS ev
       LEFT JOIN ticket_executions AS ex ON ex.id = ev.execution_id
       WHERE ev.revision > ?
       ORDER BY ev.revision
       LIMIT ?`,
    )
    .all(after, limit)
    .map((item) => ({
      actor:
        item['actor'] == null
          ? null
          : {
              client: String(item['actor']),
              onBehalfOf:
                item['actor_on_behalf_of'] == null ? null : String(item['actor_on_behalf_of']),
            },
      card: item['kind'] === 'card' ? cardOf(item['payload_json']) : null,
      kind: String(item['kind']),
      revision: Number(item['revision']),
      run: item['run_id'] == null ? null : String(item['run_id']),
      task: item['task_id'] == null ? null : String(item['task_id']),
      ticket: item['factory_dir'] == null ? null : path.basename(String(item['factory_dir'])),
    }));
}

export function createEventHub(db: DatabaseSync, pollMs = POLL_MS): EventHub {
  const subscribers = new Set<Subscriber>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function pump(): void {
    if (subscribers.size === 0) {
      return;
    }
    const oldest = Math.min(...[...subscribers].map((item) => item.cursor));
    for (const event of readEvents(db, oldest)) {
      for (const subscriber of subscribers) {
        if (event.revision > subscriber.cursor) {
          subscriber.cursor = event.revision;
          subscriber.send(event);
        }
      }
    }
  }

  return {
    close: () => {
      subscribers.clear();
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    latest: () => latestRevision(db),
    subscribe: (since, send) => {
      const subscriber = { cursor: since, send };
      subscribers.add(subscriber);
      timer ??= setInterval(pump, pollMs);
      // Catch up at once instead of waiting for the next tick.
      queueMicrotask(pump);
      return () => {
        subscribers.delete(subscriber);
        if (subscribers.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}
