import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { getAsset, isSea } from 'node:sea';
import type { DatabaseSync } from 'node:sqlite';
import { readFactoryConfig } from '../config.ts';
import { createFactoryService, factoryPaths } from '../controller/service.ts';
import { createPiHerdrRuntime, handshakeExtensionPath } from '../runtime/pi-herdr.ts';
import type { FactorySubagentRuntime } from '../runtime/runtime.ts';
import { openStateDatabase } from '../state/database.ts';
import {
  acquireServerLease,
  HEARTBEAT_MS,
  leaseIsLive,
  readServerLease,
  releaseServerLease,
  renewServerLease,
  type ServerLease,
} from './lease.ts';

export type RunningServer = {
  close: () => Promise<void>;
  instanceId: string;
  url: string;
};

export type ServeResult =
  | { kind: 'error'; message: string }
  | { kind: 'ok'; server: RunningServer };

type ServeInput = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  // Called when the server loses its lease and has shut itself down.
  onLost?: (message: string) => void;
  out: (line: string) => void;
  // Overrides FACTORY.json server.port; tests pass 0 for a free port.
  port?: number;
  // Tests pass a fake; the server builds the Herdr runtime otherwise.
  runtime?: (input: { handshakePath: string; piBin: string }) => FactorySubagentRuntime;
};

// Resolves a command the way a shell would, so launch scripts can use an
// absolute path: the Herdr dispatcher runs them in a non-login shell.
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

function piBinary(env: NodeJS.ProcessEnv): string | null {
  const override = env['FACTORY_PI_BIN'];
  if (override !== undefined && override.length > 0) {
    return path.isAbsolute(override) ? override : null;
  }
  return findOnPath('pi', env);
}

// The single executable carries the child handshake extension as an asset and
// writes it into the factory root, where each agent's Pi loads it with -e.
function handshakePath(factoryRoot: string): string {
  if (!isSea()) {
    return handshakeExtensionPath();
  }
  const file = path.join(factoryRoot, 'runtime', 'child-handshake.ts');
  const source = getAsset('child-handshake.ts', 'utf8');
  let current: string | null = null;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // Not written yet.
  }
  if (current !== source) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return file;
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

// The address clients use: a wildcard bind is reached through loopback.
function clientUrl(host: string, port: number): string {
  const reachable = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${reachable.includes(':') ? `[${reachable}]` : reachable}:${port}`;
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : port);
    });
  });
}

function closeHttp(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function heldMessage(factoryRoot: string, lease: ServerLease): string {
  return `A factory server already runs for ${factoryRoot} (pid ${lease.pid}, ${lease.url}).`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function serve(input: ServeInput): Promise<ServeResult> {
  const { codeRoot, factoryRoot } = factoryPaths(input.cwd);
  const targetPaneId = input.env['HERDR_PANE_ID'] ?? '';
  const socketPath = input.env['HERDR_SOCKET_PATH'] ?? '';
  if (targetPaneId.length === 0 || socketPath.length === 0) {
    return {
      kind: 'error',
      message:
        'factory serve must run inside a Herdr pane: HERDR_PANE_ID and HERDR_SOCKET_PATH are not set.',
    };
  }
  const piBin = piBinary(input.env);
  if (piBin === null) {
    return {
      kind: 'error',
      message: 'Cannot find pi. Put it on PATH or set FACTORY_PI_BIN to its absolute path.',
    };
  }
  if (input.runtime === undefined && findOnPath('herdr', input.env) === null) {
    return { kind: 'error', message: 'Cannot find herdr on PATH.' };
  }
  const config = readFactoryConfig(factoryRoot);
  if (config.kind === 'error') {
    return config;
  }
  const { host } = config.config.server;

  let db: DatabaseSync;
  try {
    db = openStateDatabase(factoryRoot, { create: true });
  } catch (error: unknown) {
    return { kind: 'error', message: messageOf(error) };
  }

  // Checked before binding so a second server reports the first, not a busy
  // port. Acquiring the lease below is the check that holds under a race.
  const existing = readServerLease(db);
  if (existing !== null && leaseIsLive(existing, new Date().toISOString())) {
    db.close();
    return { kind: 'error', message: heldMessage(factoryRoot, existing) };
  }

  const http = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ instanceId, status: 'ok' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 404, title: 'Not found' }));
  });
  const instanceId = randomUUID();
  let port: number;
  try {
    port = await listen(http, host, input.port ?? config.config.server.port);
  } catch (error: unknown) {
    db.close();
    return { kind: 'error', message: `Cannot listen on ${host}: ${messageOf(error)}` };
  }
  const url = clientUrl(host, port);

  const acquired = acquireServerLease(db, {
    instanceId,
    now: new Date().toISOString(),
    pid: process.pid,
    url,
  });
  if (acquired.kind === 'held') {
    await closeHttp(http);
    db.close();
    return { kind: 'error', message: heldMessage(factoryRoot, acquired.lease) };
  }

  const handshake = handshakePath(factoryRoot);
  const runtime =
    input.runtime?.({ handshakePath: handshake, piBin }) ??
    createPiHerdrRuntime({ handshakePath: handshake, piBin, socketPath, targetPaneId });
  const service = createFactoryService({
    codeRoot,
    db,
    factoryRoot,
    leaseOwner: instanceId,
    notify: input.out,
    runtime,
  });

  let closed = false;
  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    await service.stop();
    await closeHttp(http);
    releaseServerLease(db, instanceId);
    db.close();
  }

  const heartbeat = setInterval(() => {
    if (!renewServerLease(db, instanceId, new Date().toISOString())) {
      void close().then(() => {
        input.onLost?.('Another factory server took the lease; this one stopped.');
      });
    }
  }, HEARTBEAT_MS);

  if (!isLoopback(host)) {
    input.out(`Warning: listening on ${host} over plain HTTP; tokens travel unencrypted.`);
  }
  try {
    await service.recover();
  } catch (error: unknown) {
    await close();
    return { kind: 'error', message: `Recovery failed: ${messageOf(error)}` };
  }
  input.out(`Factory server for ${codeRoot} listening on ${url}`);
  return { kind: 'ok', server: { close, instanceId, url } };
}
