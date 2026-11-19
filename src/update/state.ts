import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// What the factory knows about updates, in `.factory/runtime/update.json`.
// Only the server writes it; Pi reads it for the footer line and the notice,
// and losing it only means one more notice.

const ReleaseState = z.object({ name: z.string(), notesUrl: z.string(), version: z.string() });

export const UpdateState = z.object({
  // When the newest release was first seen: a Pi session posts its notice
  // when this changes while it runs.
  announcedAt: z.string().nullable(),
  checkedAt: z.string().nullable(),
  // The version the server ran at the last check, which Pi shows as the
  // version this factory runs.
  current: z.string().nullable(),
  // The update available, or null when this factory runs the newest.
  latest: ReleaseState.nullable(),
  // The version the owner said later to: no more notices for it.
  later: z.string().nullable(),
});

export type UpdateState = z.infer<typeof UpdateState>;

export const EMPTY_UPDATE_STATE: UpdateState = {
  announcedAt: null,
  checkedAt: null,
  current: null,
  later: null,
  latest: null,
};

export function updateStatePath(factoryRoot: string): string {
  return path.join(factoryRoot, 'runtime', 'update.json');
}

export function readUpdateState(factoryRoot: string): UpdateState {
  try {
    const parsed = UpdateState.safeParse(
      JSON.parse(readFileSync(updateStatePath(factoryRoot), 'utf8')),
    );
    return parsed.success ? parsed.data : EMPTY_UPDATE_STATE;
  } catch {
    return EMPTY_UPDATE_STATE;
  }
}

export function writeUpdateState(factoryRoot: string, state: UpdateState): void {
  const file = updateStatePath(factoryRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, file);
}

// The state after a check found `latest`: a newer release than the last one
// seen is announced; the same one keeps its announcement.
export function afterCheck(input: {
  current: string;
  latest: z.infer<typeof ReleaseState> | null;
  now: string;
  previous: UpdateState;
}): UpdateState {
  const { latest, previous } = input;
  const announced =
    latest === null
      ? null
      : latest.version === previous.latest?.version
        ? previous.announcedAt
        : input.now;
  return {
    ...previous,
    announcedAt: announced,
    checkedAt: input.now,
    current: input.current,
    latest,
  };
}
