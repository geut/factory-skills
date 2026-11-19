#!/usr/bin/env node
import { isSea } from 'node:sea';
import { factoryPaths } from './controller/service.ts';
import { createFactoryClient } from './extension/factory-client.ts';
import { ghJson } from './ports/gh.ts';
import { serve } from './server/serve.ts';
import { runSessionsCommand } from './server/sessions-cli.ts';
import { runTokenCommand } from './server/token-cli.ts';
import { runTrackerCommand } from './server/tracker-cli.ts';
import { ghDownload } from './update/install.ts';
import { runUpdateCommand } from './update/update-cli.ts';
import { factoryVersion } from './version.ts';

const say = (line: string) => process.stdout.write(`${line}\n`);
const fail = (line: string) => process.stderr.write(`${line}\n`);

const usage = `Usage:
  factory serve     run the factory server for the repository in this directory
  factory token     manage API client tokens (factory token --help)
  factory sessions  list each stage's Pi session file (factory sessions [ticket])
  factory tracker   list what the Linear workspace has (factory tracker inspect)
  factory update    install the newest release (factory update --help)
  factory --version print this factory's version

Start the server inside a Herdr pane; agents open in that pane's workspace.`;

async function main(argv: Array<string>): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'token') {
    return runTokenCommand(rest, process.cwd(), { err: fail, out: say });
  }
  if (command === 'tracker') {
    return runTrackerCommand(rest, process.cwd(), { err: fail, out: say }, { env: process.env });
  }
  if (command === 'sessions') {
    return runSessionsCommand(rest, process.cwd(), { err: fail, out: say });
  }
  if (command === '--version') {
    say(factoryVersion());
    return 0;
  }
  if (command === 'update') {
    const client = createFactoryClient({ factoryRoot: factoryPaths(process.cwd()).factoryRoot });
    try {
      return await runUpdateCommand(
        rest,
        { err: fail, out: say },
        {
          arch: process.arch,
          binary: isSea() ? process.execPath : null,
          current: factoryVersion(),
          download: ghDownload,
          factoryRoot: factoryPaths(process.cwd()).factoryRoot,
          gh: ghJson,
          platform: process.platform,
          server: client.serverRunning()
            ? {
                rollback: (confirm) => client.rollback(confirm),
                update: async (mode) => {
                  const reply = await client.update(mode);
                  return reply.kind === 'notice' ? { kind: 'text', text: '' } : reply;
                },
              }
            : null,
        },
      );
    } finally {
      client.close();
    }
  }
  if (command !== 'serve') {
    fail(usage);
    return command === undefined || command === '--help' ? 0 : 2;
  }
  const after = rest[0] === '--after' ? rest[1] : undefined;
  const result = await serve({
    ...(after === undefined ? {} : { after }),
    cwd: process.cwd(),
    env: process.env,
    onLost: (message) => {
      fail(message);
      process.exit(1);
    },
    onRestarted: () => {
      say('A new factory server took over in a new pane; this one stopped.');
      process.exit(0);
    },
    out: say,
  });
  if (result.kind === 'error') {
    fail(result.message);
    return 1;
  }
  const shutdown = (): void => {
    void result.server.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // The server keeps the process alive until a signal arrives.
  return new Promise<number>(() => undefined);
}

// The single executable runs this file as CommonJS, which has no top-level await.
// oxlint-disable-next-line unicorn/prefer-top-level-await
void main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
