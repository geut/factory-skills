import type { GhJson } from '../ports/gh.ts';
import { checkForUpdate, versionOf } from './releases.ts';

export const updateUsage = `Usage:
  factory update --check   check GitHub for a newer release

Works without a server. A running server checks on its own, on start and
once a day; FACTORY.json \`updates: { "check": false }\` turns that off.`;

type Io = { err: (line: string) => void; out: (line: string) => void };

export async function runUpdateCommand(
  args: Array<string>,
  io: Io,
  deps: { current: string; gh: GhJson },
): Promise<number> {
  const [flag, ...extra] = args;
  if (flag === '--help' || flag === '-h') {
    io.out(updateUsage);
    return 0;
  }
  if (flag === undefined) {
    io.err(
      'This factory cannot install updates itself yet: download the release from its page and replace the binary, then restart `factory serve`.',
    );
    return 1;
  }
  if (flag !== '--check' || extra.length > 0) {
    io.err(updateUsage);
    return 2;
  }
  const current = versionOf(deps.current) ?? deps.current;
  let update;
  try {
    update = await checkForUpdate({ current, gh: deps.gh });
  } catch (error: unknown) {
    io.err(`Cannot check for updates: ${error instanceof Error ? error.message : String(error)}`);
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
