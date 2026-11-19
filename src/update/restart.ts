import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { herdrPaneArgs, parsePaneId, type CommandRunner } from '../runtime/pi-herdr.ts';
import { shellQuote } from '../shell.ts';

// Restarting the server on the binary on disk: a new Herdr pane runs
// `factory serve --after <instance>`, which waits for this server to hand back
// its lease. Agents keep running and the new server adopts them, as on any
// restart.

// Names a pane sets for itself, or that make no sense in another shell.
const OWN_TO_PANE = new Set([
  'FACTORY_LAUNCH_SCRIPT',
  'HERDR_PANE_ID',
  'OLDPWD',
  'PWD',
  'SHLVL',
  '_',
]);

// The new server needs what the old one had: the same PATH for the project's
// toolchain, and the same keys, such as a Linear API key. The script holds
// them, so it is the owner's alone and deletes itself as it starts.
export function renderRestartScript(input: {
  after: string;
  binary: string;
  codeRoot: string;
  env: NodeJS.ProcessEnv;
  paneId: string;
}): string {
  const exports = Object.entries(input.env)
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) &&
        !OWN_TO_PANE.has(entry[0]),
    )
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
    .join('');
  return `#!/usr/bin/env bash
rm -f -- "$0"
${exports}export HERDR_PANE_ID="\${HERDR_PANE_ID:-${input.paneId}}"
cd ${shellQuote(input.codeRoot)} || exit 1
exec ${shellQuote(input.binary)} serve --after ${shellQuote(input.after)}
`;
}

// Opens the new server's pane beside this server's.
export async function openServerPane(input: {
  after: string;
  binary: string;
  codeRoot: string;
  env: NodeJS.ProcessEnv;
  factoryRoot: string;
  paneId: string;
  run: CommandRunner;
}): Promise<void> {
  const script = path.join(input.factoryRoot, 'runtime', `restart-${input.after}.sh`);
  await mkdir(path.dirname(script), { recursive: true });
  writeFileSync(script, renderRestartScript(input), { mode: 0o700 });
  const opened = await input.run(
    herdrPaneArgs({ cwd: input.codeRoot, launchScript: script, targetPaneId: input.paneId }),
  );
  if (opened.code !== 0 || parsePaneId(opened.stdout) === null) {
    throw new Error(opened.stderr.trim() || 'herdr did not open the new server pane');
  }
}

// Waits while the server `instanceId` holds the lease, up to `timeoutMs`.
export async function waitForHandoff(input: {
  held: () => boolean;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + (input.timeoutMs ?? 60_000);
  while (input.held()) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 200));
  }
  return true;
}
