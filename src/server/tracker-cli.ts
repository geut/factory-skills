import { readFactoryConfig, type TrackerConfig } from '../config.ts';
import { factoryPaths } from '../controller/service.ts';
import { formatLinearInventory } from '../ports/linear.ts';
import { linearFromEnv, linearInventory, type TrackerClients } from '../ports/trackers.ts';

export const trackerUsage = `Usage:
  factory tracker inspect [--json]   list what the Linear workspace has

Lists the teams the API key can see, each team's workflow states (name and
type, in workflow order) and labels, the workspace's labels, and its projects:
the names FACTORY.json's tracker settings can use. The factory never creates
them. The key is read from the configured tracker's apiKeyEnv, else
LINEAR_API_KEY, so this works before the tracker is set up.`;

type Io = { err: (line: string) => void; out: (line: string) => void };

export async function runTrackerCommand(
  args: Array<string>,
  cwd: string,
  io: Io,
  deps: { env: NodeJS.ProcessEnv; linear?: TrackerClients['linear'] },
): Promise<number> {
  const [command, ...flags] = args;
  if (command !== 'inspect' || flags.some((flag) => flag !== '--json')) {
    io.err(trackerUsage);
    return command === undefined || command === '--help' ? 0 : 2;
  }
  // FACTORY.json is optional here: it only says which variable holds the key.
  const read = readFactoryConfig(factoryPaths(cwd).factoryRoot);
  const config: TrackerConfig | null = read.kind === 'ok' ? read.config.tracker : null;
  const found = await linearInventory(config, deps.env, deps.linear ?? linearFromEnv(deps.env));
  if (found.kind === 'error') {
    io.err(found.message);
    return 1;
  }
  if (flags.includes('--json')) {
    io.out(JSON.stringify(found.inventory, null, 2));
  } else {
    for (const line of formatLinearInventory(found.inventory)) {
      io.out(line);
    }
  }
  return 0;
}
