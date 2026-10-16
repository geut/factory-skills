#!/usr/bin/env node
import { serve } from './server/serve.ts';
import { runSessionsCommand } from './server/sessions-cli.ts';
import { runTokenCommand } from './server/token-cli.ts';

const say = (line: string) => process.stdout.write(`${line}\n`);
const fail = (line: string) => process.stderr.write(`${line}\n`);

const usage = `Usage:
  factory serve     run the factory server for the repository in this directory
  factory token     manage API client tokens (factory token --help)
  factory sessions  list each stage's Pi session file (factory sessions [ticket])

Start the server inside a Herdr pane; agents open in that pane's workspace.`;

async function main(argv: Array<string>): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'token') {
    return runTokenCommand(rest, process.cwd(), { err: fail, out: say });
  }
  if (command === 'sessions') {
    return runSessionsCommand(rest, process.cwd(), { err: fail, out: say });
  }
  if (command !== 'serve') {
    fail(usage);
    return command === undefined || command === '--help' ? 0 : 2;
  }
  const result = await serve({
    cwd: process.cwd(),
    env: process.env,
    onLost: (message) => {
      fail(message);
      process.exit(1);
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
