import { existsSync } from 'node:fs';
import { factoryPaths } from '../controller/service.ts';
import { openStateDatabase } from '../state/database.ts';
import { createClient, isScope, listClients, revokeClient } from './clients.ts';

export const tokenUsage = `Usage:
  factory token create <name> --scope read|act   prints the token once
  factory token list
  factory token revoke <name>

Manages API clients for the factory root in the current directory. Rotate a
token by revoking it and creating it again, or by creating a client with a
new name first.`;

type Io = { err: (line: string) => void; out: (line: string) => void };

function scopeArgument(args: Array<string>): string | null {
  const index = args.indexOf('--scope');
  if (index !== -1) {
    return args[index + 1] ?? null;
  }
  const inline = args.find((arg) => arg.startsWith('--scope='));
  return inline === undefined ? null : inline.slice('--scope='.length);
}

export function runTokenCommand(args: Array<string>, cwd: string, io: Io): number {
  const [action, name] = args;
  const { factoryRoot } = factoryPaths(cwd);
  if (action === undefined || action === '--help') {
    io.err(tokenUsage);
    return action === undefined ? 2 : 0;
  }
  if (!existsSync(factoryRoot)) {
    io.err(`No factory root at ${factoryRoot}. Run this from the repository root.`);
    return 1;
  }
  const db = openStateDatabase(factoryRoot, { create: true });
  const now = new Date().toISOString();
  try {
    if (action === 'create') {
      const scope = scopeArgument(args);
      if (name === undefined || name.startsWith('--') || scope === null || !isScope(scope)) {
        io.err(tokenUsage);
        return 2;
      }
      const created = createClient(db, { name, now, scope });
      if (created.kind === 'error') {
        io.err(created.message);
        return 1;
      }
      io.out(created.token);
      io.err(`Created ${name} with ${scope} scope. Store the token now; it is not shown again.`);
      return 0;
    }
    if (action === 'list') {
      const clients = listClients(db);
      if (clients.length === 0) {
        io.err('No API clients yet.');
        return 0;
      }
      for (const client of clients) {
        const state =
          client.revokedAt === null ? `last used ${client.lastUsedAt ?? 'never'}` : 'revoked';
        io.out(`${client.name}\t${client.scope}\tcreated ${client.createdAt}\t${state}`);
      }
      return 0;
    }
    if (action === 'revoke') {
      if (name === undefined) {
        io.err(tokenUsage);
        return 2;
      }
      if (!revokeClient(db, name, now)) {
        io.err(`No live client named ${name}.`);
        return 1;
      }
      io.err(`Revoked ${name}. Requests with its token now get 401.`);
      return 0;
    }
    io.err(tokenUsage);
    return 2;
  } finally {
    db.close();
  }
}
