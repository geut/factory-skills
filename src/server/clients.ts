import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { problem, type Problem } from '../api/problem.ts';
import type { Scope } from '../api/route.ts';
import type { Actor } from '../domain.ts';
import { sha256 } from '../hash.ts';
import { immediateTransaction } from '../state/database.ts';

// API clients are named holders of a factory server token. The database keeps
// only each token's SHA-256; whoever can reach the factory root manages them.

export type ApiClient = {
  createdAt: string;
  lastUsedAt: string | null;
  name: string;
  revokedAt: string | null;
  scope: Scope;
};

// The client the server creates for Pi on the same machine.
export const LOCAL_CLIENT = 'local';
export const LOCAL_TOKEN_FILE = 'local.token';
export const ON_BEHALF_OF_HEADER = 'x-factory-on-behalf-of';
const ON_BEHALF_OF_MAX = 200;
const TOKEN_PREFIX = 'fct_';
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isScope(value: string): value is Scope {
  return value === 'read' || value === 'act';
}

// `act` includes `read`.
export function scopeAllows(have: Scope, need: Scope): boolean {
  return have === 'act' || need === 'read';
}

function newToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function clientFromRow(value: Record<string, unknown>): ApiClient {
  const scope = String(value['scope']);
  return {
    createdAt: String(value['created_at']),
    lastUsedAt: value['last_used_at'] === null ? null : String(value['last_used_at']),
    name: String(value['name']),
    revokedAt: value['revoked_at'] === null ? null : String(value['revoked_at']),
    scope: isScope(scope) ? scope : 'read',
  };
}

function findClient(db: DatabaseSync, name: string): ApiClient | null {
  const found = db.prepare('SELECT * FROM api_clients WHERE name = ?').get(name);
  return found === undefined ? null : clientFromRow(found);
}

// Writes a client with a fresh token, replacing a revoked one of the same name.
function issue(db: DatabaseSync, name: string, scope: Scope, now: string): string {
  const token = newToken();
  db.prepare(
    `INSERT INTO api_clients (name, scope, token_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL, NULL)
     ON CONFLICT (name) DO UPDATE SET
       scope = excluded.scope, token_hash = excluded.token_hash, created_at = excluded.created_at,
       last_used_at = NULL, revoked_at = NULL`,
  ).run(name, scope, sha256(token), now);
  return token;
}

export type CreateResult = { kind: 'created'; token: string } | { kind: 'error'; message: string };

export function createClient(
  db: DatabaseSync,
  input: { name: string; now: string; scope: Scope },
): CreateResult {
  if (!NAME_RE.test(input.name)) {
    return {
      kind: 'error',
      message: `Client names use lowercase letters, digits, - and _, up to 64 characters.`,
    };
  }
  if (input.name === LOCAL_CLIENT) {
    return {
      kind: 'error',
      message: `${LOCAL_CLIENT} is the server's own client for Pi; pick another name.`,
    };
  }
  return immediateTransaction(db, () => {
    const existing = findClient(db, input.name);
    if (existing !== null && existing.revokedAt === null) {
      return {
        kind: 'error',
        message: `Client ${input.name} already has a token. Revoke it first, or create a client with another name.`,
      };
    }
    return { kind: 'created', token: issue(db, input.name, input.scope, input.now) };
  });
}

export function listClients(db: DatabaseSync): Array<ApiClient> {
  return db.prepare('SELECT * FROM api_clients ORDER BY name').all().map(clientFromRow);
}

// False when no live client has that name.
export function revokeClient(db: DatabaseSync, name: string, now: string): boolean {
  const revoked = db
    .prepare('UPDATE api_clients SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL')
    .run(now, name);
  return revoked.changes === 1;
}

// The live client a token belongs to, which is then marked as used.
export function authenticate(db: DatabaseSync, token: string, now: string): ApiClient | null {
  const found = db
    .prepare('SELECT * FROM api_clients WHERE token_hash = ? AND revoked_at IS NULL')
    .get(sha256(token));
  if (found === undefined) {
    return null;
  }
  const client = clientFromRow(found);
  db.prepare('UPDATE api_clients SET last_used_at = ? WHERE name = ?').run(now, client.name);
  return client;
}

export function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

export function actorFor(request: IncomingMessage, client: ApiClient): Actor {
  const raw = request.headers[ON_BEHALF_OF_HEADER];
  const claimed = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  return {
    client: client.name,
    onBehalfOf: claimed.length === 0 ? null : claimed.slice(0, ON_BEHALF_OF_MAX),
  };
}

export function localTokenPath(factoryRoot: string): string {
  return path.join(factoryRoot, LOCAL_TOKEN_FILE);
}

// Makes sure `.factory/local.token` holds the live token of the `local` act
// client, readable only by its owner. A missing file, a revoked client, or a
// token that no longer matches gets a fresh token.
export function ensureLocalClient(db: DatabaseSync, factoryRoot: string, now: string): void {
  const file = localTokenPath(factoryRoot);
  let current: string | null = null;
  try {
    current = readFileSync(file, 'utf8').trim();
  } catch {
    // Not written yet.
  }
  immediateTransaction(db, () => {
    const live =
      current !== null &&
      db
        .prepare(
          'SELECT 1 FROM api_clients WHERE name = ? AND token_hash = ? AND revoked_at IS NULL',
        )
        .get(LOCAL_CLIENT, sha256(current)) !== undefined;
    if (!live) {
      const token = issue(db, LOCAL_CLIENT, 'act', now);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${token}\n`, { mode: 0o600 });
    }
  });
  // writeFileSync only applies the mode to a new file.
  chmodSync(file, 0o600);
}

// The router's authorize hook: a live bearer token whose scope covers the route.
export function createAuthorizer(
  db: DatabaseSync,
  now: () => string,
): (request: IncomingMessage, scope: Scope) => { actor: Actor } | { problem: Problem } {
  return (request, scope) => {
    const token = bearerToken(request);
    if (token === null) {
      return { problem: problem('unauthorized', 'Send Authorization: Bearer <token>.') };
    }
    const client = authenticate(db, token, now());
    if (client === null) {
      return { problem: problem('unauthorized', 'The token is unknown or revoked.') };
    }
    if (!scopeAllows(client.scope, scope)) {
      return {
        problem: problem(
          'insufficient_scope',
          `This route needs a ${scope} token; ${client.name} has ${client.scope}.`,
        ),
      };
    }
    return { actor: actorFor(request, client) };
  };
}
