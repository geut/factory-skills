import type { GhJson } from '../ports/gh.ts';
import { installRelease, type Download } from './install.ts';
import { checkForUpdate, versionOf } from './releases.ts';
import { SOURCE_RUN_MESSAGE } from './updater.ts';

export const updateUsage = `Usage:
  factory update               install the newest release and restart on it
  factory update --when-idle   the same, once no agent runs and nothing is queued
  factory update --check       check GitHub for a newer release

With a server running for this repository, the server updates and restarts
itself in a new Herdr pane. With none, the binary is replaced, and the next
factory serve runs the new version. The replaced binary stays beside it as
factory.previous.

A running server checks on its own once a day; FACTORY.json
\`updates: { "check": false }\` turns that off.`;

type Io = { err: (line: string) => void; out: (line: string) => void };

// The running server, when there is one: the factory client's update call.
export type ServerUpdate = (
  mode: 'install' | 'when-idle',
) => Promise<{ kind: 'problem' | 'text'; text: string }>;

export async function runUpdateCommand(
  args: Array<string>,
  io: Io,
  deps: {
    arch: string;
    // The running binary, or null for a source run.
    binary: string | null;
    current: string;
    download: Download;
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
    const reply = await deps.server(flag === '--when-idle' ? 'when-idle' : 'install');
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
