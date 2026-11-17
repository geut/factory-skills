import { spawn } from 'node:child_process';

// Every gh call the server makes runs here: as a child process the server
// awaits, so a slow or stuck GitHub never blocks the event loop and the API,
// webhooks, and other actions keep running. Its output is read whole. The
// timeout only ends a gh that is stuck; the caller's retry or error path
// takes over.

export const GH_TIMEOUT_MS = 5 * 60 * 1000;

export function runCommand(input: {
  args: Array<string>;
  command: string;
  stdin: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: input.timeoutMs,
    });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const out = Buffer.concat(stdout).toString('utf8');
      if (code === 0) {
        resolve(out);
        return;
      }
      const err = Buffer.concat(stderr).toString('utf8');
      reject(
        new Error(
          signal === null
            ? (err || out).trim() || `${input.command} exited with code ${code ?? 'unknown'}`
            : `${input.command} was stopped by ${signal} after ${input.timeoutMs} ms`,
        ),
      );
    });
    // A command that exits before reading stdin must not crash the server.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input.stdin);
  });
}

// The gh binary: FACTORY_GH_BIN, for a test's stand-in, else gh on PATH.
function ghBinary(): string {
  const configured = process.env['FACTORY_GH_BIN'];
  return configured === undefined || configured.length === 0 ? 'gh' : configured;
}

// Runs gh with `stdin`, and gives back its output.
export type GhRun = (args: Array<string>, stdin: string) => Promise<string>;

export const ghRun: GhRun = (args, stdin) =>
  runCommand({ args, command: ghBinary(), stdin, timeoutMs: GH_TIMEOUT_MS });

// Runs gh and parses its JSON output.
export type GhJson = (args: Array<string>) => Promise<unknown>;

export const ghJson: GhJson = async (args) => {
  const parsed: unknown = JSON.parse(await ghRun(args, ''));
  return parsed;
};

// A port method a test's stand-in may answer at once; the real one is async.
export type MaybePromise<T> = Promise<T> | T;
