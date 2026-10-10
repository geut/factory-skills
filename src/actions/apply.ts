import type { DatabaseSync } from 'node:sqlite';
import { applyControllerEvent, type ApplyResult } from '../controller/store.ts';
import type { ControllerEvent, IdSource } from '../domain.ts';

// Applies the event an action worker produced. The dedupe key makes a
// repeated action report its result once.
export function applyActionEvent(
  input: { db: DatabaseSync; ids: IdSource; now: () => string },
  event: ControllerEvent,
  dedupeKey: string,
): ApplyResult {
  return applyControllerEvent(input.db, {
    dedupeKey,
    event,
    ids: input.ids,
    now: input.now(),
    source: 'action',
  });
}
