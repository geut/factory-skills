import type { GhJson } from '../ports/gh.ts';
import { SCHEMA_VERSION, stateDatabasePath } from '../state/database.ts';
import { installRelease, type Download } from './install.ts';
import { checkForUpdate, versionOf } from './releases.ts';
import {
  lossSince,
  planRollback,
  restoreDatabase,
  rollbackQuestion,
  storedSchemaVersion,
  swapBack,
} from './rollback.ts';
import { readUpdateState, writeUpdateState } from './state.ts';
import { SOURCE_RUN_MESSAGE } from './updater.ts';

export const updateUsage = `Usage:
  factory update               install the newest release and restart on it
  factory update --when-idle   the same, once no agent runs and nothing is queued
  factory update --check       check GitHub for a newer release
  factory update --rollback    go back to the version the last update replaced
                               (--yes confirms restoring the database)

With a server running for this repository, the server updates and restarts
itself in a new Herdr pane. With none, the binary is replaced, and the next
factory serve runs the new version. The replaced binary stays beside it as
factory.previous.

A running server checks on its own once a day; FACTORY.json
\`updates: { "check": false }\` turns that off.`;

type Io = { err: (line: string) => void; out: (line: string) => void };

// The running server, when there is one: the factory client's calls.
export type ServerUpdate = {
  rollback: (confirm: boolean) => Promise<{ kind: 'confirm' | 'problem' | 'text'; text: string }>;
  update: (mode: 'install' | 'when-idle') => Promise<{ kind: 'problem' | 'text'; text: string }>;
};

export const ROLLBACK_YES_HINT = 'Run factory update --rollback --yes to go ahead.';

export async function runUpdateCommand(
  args: Array<string>,
  io: Io,
  deps: {
    arch: string;
    // The running binary, or null for a source run.
    binary: string | null;
    current: string;
    download: Download;
    // The factory in this directory, for a rollback with no server running.
    factoryRoot: string;
    gh: GhJson;
    platform: string;
    // Null when no server runs for this repository.
    server: ServerUpdate | null;
  },
): Promise<number> {
  const [flag, ...extra] = args;
  if (flag === '--help' || flag === '-h') {
    io.out(updateUsage);
    return 0;
  }
  if (
    flag === '--rollback' &&
    (extra.length === 0 || (extra.length === 1 && extra[0] === '--yes'))
  ) {
    return rollBack({ confirm: extra[0] === '--yes', deps, io });
  }
  if (extra.length > 0 || (flag !== undefined && flag !== '--check' && flag !== '--when-idle')) {
    io.err(updateUsage);
    return 2;
  }
  const current = versionOf(deps.current) ?? deps.current;
  if (flag === '--check') {
    let update;
    try {
      update = await checkForUpdate({ current, gh: deps.gh });
    } catch (error: unknown) {
      io.err(`Cannot check for updates: ${messageOf(error)}`);
      return 1;
    }
    if (update === null) {
      io.out(`factory ${current} is the newest release.`);
      return 0;
    }
    io.out(`factory ${update.version} is available (you run ${current}).`);
    io.out(`What's new: ${update.notesUrl}`);
    return 0;
  }
  if (deps.server !== null) {
    const reply = await deps.server.update(flag === '--when-idle' ? 'when-idle' : 'install');
    if (reply.kind === 'problem') {
      io.err(reply.text);
      return 1;
    }
    io.out(reply.text);
    return 0;
  }
  if (deps.binary === null) {
    io.err(SOURCE_RUN_MESSAGE);
    return 1;
  }
  let update;
  try {
    update = await checkForUpdate({ current, gh: deps.gh });
  } catch (error: unknown) {
    io.err(`Cannot check for updates: ${messageOf(error)}`);
    return 1;
  }
  if (update === null) {
    io.out(`factory ${current} is the newest release.`);
    return 0;
  }
  const installed = await installRelease({
    arch: deps.arch,
    binary: deps.binary,
    download: deps.download,
    platform: deps.platform,
    running: { schema: SCHEMA_VERSION, version: current },
    version: update.version,
  });
  if (installed.kind === 'error') {
    io.err(installed.message);
    return 1;
  }
  io.out(`Installed factory ${update.version}; the next factory serve runs it.`);
  io.out(`What's new: ${update.notesUrl}`);
  return 0;
}

async function rollBack(input: {
  confirm: boolean;
  deps: Parameters<typeof runUpdateCommand>[2];
  io: Io;
}): Promise<number> {
  const { deps, io } = input;
  if (deps.server !== null) {
    const reply = await deps.server.rollback(input.confirm);
    if (reply.kind === 'problem') {
      io.err(reply.text);
      return 1;
    }
    io.out(reply.text);
    if (reply.kind === 'confirm') {
      io.out(ROLLBACK_YES_HINT);
      return 1;
    }
    return 0;
  }
  if (deps.binary === null) {
    io.err(SOURCE_RUN_MESSAGE);
    return 1;
  }
  const current = { schema: SCHEMA_VERSION, version: versionOf(deps.current) ?? deps.current };
  const databasePath = stateDatabasePath(deps.factoryRoot);
  let plan: ReturnType<typeof planRollback>;
  try {
    plan = planRollback({
      binary: deps.binary,
      current,
      databasePath,
      loss: (backup) => lossSince({ backup, databasePath }),
      storedSchema: storedSchemaVersion(databasePath),
    });
  } catch (error: unknown) {
    io.err(`Cannot read the database or its backup, so nothing changed: ${messageOf(error)}`);
    return 1;
  }
  if (plan.kind === 'refused') {
    io.err(plan.message);
    return 1;
  }
  if (plan.restore !== null && !input.confirm) {
    io.out(rollbackQuestion({ current: current.version, plan }));
    io.out(ROLLBACK_YES_HINT);
    return 1;
  }
  try {
    swapBack({ binary: deps.binary, current });
  } catch (error: unknown) {
    io.err(`The rollback failed, and nothing changed: ${messageOf(error)}`);
    return 1;
  }
  if (plan.restore !== null) {
    try {
      restoreDatabase({ backup: plan.restore.backup, databasePath });
    } catch (error: unknown) {
      // The older binary cannot open this database: put the binaries back.
      try {
        swapBack({ binary: deps.binary, current: plan.previous });
      } catch {
        io.err(
          `Could not restore ${plan.restore.backup} (${messageOf(error)}), nor put the binaries back: swap factory.previous back by hand before starting factory serve.`,
        );
        return 1;
      }
      io.err(`Could not restore ${plan.restore.backup}, so nothing changed: ${messageOf(error)}`);
      return 1;
    }
  }
  // The release rolled back from stays on offer, without its cards.
  writeUpdateState(deps.factoryRoot, {
    ...readUpdateState(deps.factoryRoot),
    installed: null,
    later: current.version,
    pending: false,
  });
  io.out(
    `Rolled back to factory ${plan.previous.version}${plan.restore === null ? '' : `, with the database from ${plan.restore.madeAt}`}; the next factory serve runs it.`,
  );
  return 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
