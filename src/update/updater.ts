import { statSync } from 'node:fs';
import type { UpdateChecker } from './checker.ts';
import { installRelease, type Download } from './install.ts';
import { compareVersions } from './releases.ts';
import { readUpdateState, writeUpdateState } from './state.ts';

// Updating the factory (GLOSSARY.md): install the newest release and restart
// the server on it. The server alone runs it, for Pi, the API, and the
// command line alike.

export type UpdateResult =
  // A new server is starting on the update; this one stops.
  | { kind: 'restarting'; message: string }
  // It waits for nothing to run or be queued.
  | { kind: 'pending'; message: string }
  | { kind: 'none'; message: string }
  // A source run, or an update already under way.
  | { kind: 'refused'; message: string }
  | { kind: 'failed'; message: string };

export type Updater = {
  close: () => void;
  // Looks at the binary on disk now, as the poll does.
  probe: () => Promise<void>;
  // Watches the binary on disk, and runs a pending update once idle.
  start: () => void;
  update: (input: { whenIdle: boolean }) => Promise<UpdateResult>;
};

export const UPDATE_POLL_MS = 10_000;

export const SOURCE_RUN_MESSAGE = 'This factory runs from source; update it with git pull.';

export function createUpdater(input: {
  arch: string;
  // The running binary, or null when the factory runs from source.
  binary: string | null;
  checker: UpdateChecker;
  current: string;
  download: Download;
  factoryRoot: string;
  // Whether no agent runs and no action is queued.
  idle: () => boolean;
  now: () => string;
  platform: string;
  pollMs?: number;
  // What the server prints, for updates that run on their own.
  report: (line: string) => void;
  // Starts a new server on the binary on disk and stops this one.
  restart: () => Promise<void>;
  version: (binary: string) => Promise<string | null>;
}): Updater {
  const { binary, current, factoryRoot } = input;
  let busy = false;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let seenBinary: string | null = null;

  function save(change: Partial<ReturnType<typeof readUpdateState>>): void {
    writeUpdateState(factoryRoot, { ...readUpdateState(factoryRoot), ...change });
  }

  // Records a newer version in the binary on disk, put there by another
  // factory that shares it, and announces it once.
  async function probe(): Promise<void> {
    if (binary === null || closed || busy) {
      return;
    }
    const stat = statSync(binary, { throwIfNoEntry: false });
    const key = stat === undefined ? 'missing' : `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    if (key === seenBinary) {
      return;
    }
    seenBinary = key;
    const found = stat === undefined ? null : await input.version(binary);
    if (closed || busy) {
      return;
    }
    const installed = found !== null && compareVersions(found, current) > 0 ? found : null;
    const state = readUpdateState(factoryRoot);
    if (installed !== state.installed) {
      save({
        announcedAt: installed === null ? state.announcedAt : input.now(),
        installed,
      });
    }
  }

  // Never rejects: a pending update runs from the poll, where an error would
  // end the server. Whatever fails is a failed update.
  async function update(request: { whenIdle: boolean }): Promise<UpdateResult> {
    try {
      return await attempt(request);
    } catch (error: unknown) {
      busy = false;
      return {
        kind: 'failed',
        message: `The update failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async function attempt(request: { whenIdle: boolean }): Promise<UpdateResult> {
    if (binary === null) {
      return { kind: 'refused', message: SOURCE_RUN_MESSAGE };
    }
    if (busy) {
      return { kind: 'refused', message: 'An update is already under way.' };
    }
    busy = true;
    let restarting = false;
    try {
      let view = input.checker.view();
      if (view === null) {
        const checked = await input.checker.check();
        if (checked.kind === 'failed') {
          return { kind: 'failed', message: `Cannot check for updates: ${checked.message}` };
        }
        view = input.checker.view();
      }
      if (view === null) {
        return { kind: 'none', message: `factory ${current} is the newest release.` };
      }
      if (request.whenIdle && !input.idle()) {
        save({ pending: true });
        return {
          kind: 'pending',
          message: `factory ${view.latest} will install once no agent runs and nothing is queued.`,
        };
      }
      if (!view.installed) {
        const installed = await installRelease({
          arch: input.arch,
          binary,
          download: input.download,
          platform: input.platform,
          version: view.latest,
        });
        if (installed.kind === 'error') {
          return { kind: 'failed', message: installed.message };
        }
        // Another try only restarts: downloading again would replace
        // factory.previous with the update.
        save({ installed: view.latest });
      }
      save({ pending: false });
      restarting = true;
      // Answered first: the restart closes this server.
      setTimeout(() => {
        void input.restart().catch((error: unknown) => {
          busy = false;
          input.report(
            `factory ${view.latest} is installed, but the server could not restart on it: ${error instanceof Error ? error.message : String(error)}. Restart factory serve to run it.`,
          );
        });
      }, 0);
      return {
        kind: 'restarting',
        message: view.installed
          ? `Restarting on factory ${view.latest}: a new server starts in a new pane, and this one stops.`
          : `Installed factory ${view.latest}; a new server starts on it in a new pane, and this one stops.`,
      };
    } finally {
      if (!restarting) {
        busy = false;
      }
    }
  }

  // One poll: look at the binary on disk, then run a pending update once
  // idle. A background poll never ends the server: anything that fails is
  // reported, and the next poll tries again.
  async function poll(): Promise<void> {
    await probe();
    if (closed || busy || !readUpdateState(factoryRoot).pending || !input.idle()) {
      return;
    }
    const result = await update({ whenIdle: false });
    input.report(result.message);
    // A failed update waits for the owner rather than retrying every poll.
    if (result.kind !== 'restarting') {
      save({ pending: false });
    }
  }

  function tick(): void {
    if (closed || busy) {
      return;
    }
    poll().catch((error: unknown) => {
      input.report(`Update poll failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return {
    close: () => {
      closed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    probe,
    start: () => {
      if (closed) {
        return;
      }
      timer = setInterval(tick, input.pollMs ?? UPDATE_POLL_MS);
      timer.unref();
      tick();
    },
    update,
  };
}
