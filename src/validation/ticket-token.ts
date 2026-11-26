import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// A ticket's token: what its agents show the server to ask for controller
// work, such as a validation while they iterate. One per execution, from its
// plan to its end; the server refuses it once the execution is complete,
// cancelled, or retired, and a rerun is an execution of its own. It is an
// HMAC of the execution's id under a secret only the factory's server keeps,
// so nothing is stored per ticket. It grants nothing on its own: each route
// that takes it checks what the ticket is doing.

export { SERVER_URL_ENV, TICKET_KEY_ENV, TICKET_TOKEN_ENV } from '../runtime/ticket-access.ts';

const SECRET_FILE = 'ticket-token.key';

function secretPath(factoryRoot: string): string {
  return path.join(factoryRoot, 'runtime', SECRET_FILE);
}

// The server's secret, made on first use, private to the owner.
export function ticketTokenSecret(factoryRoot: string): Buffer {
  const file = secretPath(factoryRoot);
  try {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored.length >= 64) {
      return Buffer.from(stored, 'hex');
    }
  } catch {
    // Not made yet.
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const secret = randomBytes(32);
  writeFileSync(file, `${secret.toString('hex')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

export function ticketToken(secret: Buffer, executionId: string): string {
  return createHmac('sha256', secret).update(`ticket:${executionId}`).digest('hex');
}

// Whether `token` is the execution's.
export function isTicketToken(secret: Buffer, executionId: string, token: string): boolean {
  const expected = Buffer.from(ticketToken(secret, executionId), 'utf8');
  const given = Buffer.from(token, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
