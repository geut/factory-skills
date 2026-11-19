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
  check: () => Promise<CheckOutcome>;
  later: () => UpdateView | null;
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
  return {
    check: async () => {
      if (!input.enabled()) {
        // Pi stops showing what an earlier check found.
        const state = readUpdateState(factoryRoot);
        if (state.latest !== null) {
          writeUpdateState(factoryRoot, { ...state, announcedAt: null, latest: null });
        }
        return { kind: 'off' };
      }
      try {
        const latest = await checkForUpdate({ current, gh: input.gh });
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
    view: () => updateView(readUpdateState(factoryRoot), current),
  };
}
