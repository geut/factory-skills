import type { GhJson } from '../ports/gh.ts';
import { checkForUpdate } from './releases.ts';
import { afterCheck, readUpdateState, writeUpdateState, type UpdateState } from './state.ts';

// The server's side of updates: it checks GitHub on start and once a day,
// records what it found, and answers for it.

export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

// What clients see of an update: the release this factory could run instead.
export type UpdateView = {
  current: string;
  // Whether the owner said later to it.
  later: boolean;
  latest: string;
  name: string;
  notesUrl: string;
};

export function updateView(state: UpdateState, current: string): UpdateView | null {
  return state.latest === null
    ? null
    : {
        current,
        later: state.later === state.latest.version,
        latest: state.latest.version,
        name: state.latest.name,
        notesUrl: state.latest.notesUrl,
      };
}

export type CheckOutcome =
  | { kind: 'checked'; update: UpdateView | null }
  | { kind: 'failed'; message: string }
  // FACTORY.json turns checks off.
  | { kind: 'off' };

export type UpdateChecker = {
  // Checks now. A check already running is shared, not repeated.
  check: () => Promise<CheckOutcome>;
  // Stops the schedule; a check still running records nothing.
  close: () => void;
  later: () => UpdateView | null;
  // Checks once a day, counted from the last check recorded, so a restart
  // does not ask GitHub again. A new version of the server checks at once.
  start: () => void;
  view: () => UpdateView | null;
};

export function createUpdateChecker(input: {
  current: string;
  enabled: () => boolean;
  factoryRoot: string;
  gh: GhJson;
  now: () => string;
}): UpdateChecker {
  const { current, factoryRoot } = input;
  let running: Promise<CheckOutcome> | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function run(): Promise<CheckOutcome> {
    if (!input.enabled()) {
      // Pi stops showing what an earlier check found.
      const state = readUpdateState(factoryRoot);
      if (state.latest !== null && !closed) {
        writeUpdateState(factoryRoot, { ...state, announcedAt: null, latest: null });
      }
      return { kind: 'off' };
    }
    try {
      const latest = await checkForUpdate({ current, gh: input.gh });
      if (closed) {
        return { kind: 'failed', message: 'The server stopped during the check.' };
      }
      const state = afterCheck({
        current,
        latest,
        now: input.now(),
        previous: readUpdateState(factoryRoot),
      });
      writeUpdateState(factoryRoot, state);
      return { kind: 'checked', update: updateView(state, current) };
    } catch (error: unknown) {
      // A check that fails stays quiet; the next one tries again.
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
  }

  function check(): Promise<CheckOutcome> {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  }

  function schedule(delay: number): void {
    if (closed) {
      return;
    }
    timer = setTimeout(() => {
      void check().finally(() => schedule(CHECK_EVERY_MS));
    }, delay);
    timer.unref();
  }

  return {
    check,
    close: () => {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    later: () => {
      const state = readUpdateState(factoryRoot);
      if (state.latest === null) {
        return null;
      }
      const next = { ...state, later: state.latest.version };
      writeUpdateState(factoryRoot, next);
      return updateView(next, current);
    },
    start: () => {
      schedule(dueIn({ current, now: input.now(), state: readUpdateState(factoryRoot) }));
    },
    view: () => updateView(readUpdateState(factoryRoot), current),
  };
}

// How long until the next check is due: a day after the last one recorded,
// or now when there was none or a different version made it.
export function dueIn(input: { current: string; now: string; state: UpdateState }): number {
  const { state } = input;
  if (state.checkedAt === null || state.current !== input.current) {
    return 0;
  }
  const since = Date.parse(input.now) - Date.parse(state.checkedAt);
  return Number.isNaN(since) ? 0 : Math.min(CHECK_EVERY_MS, Math.max(0, CHECK_EVERY_MS - since));
}
