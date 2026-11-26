import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { isTicketToken, ticketToken, ticketTokenSecret } from './ticket-token.ts';

const dirs: Array<string> = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('the secret is made once, private, and kept; a token is its execution’s alone', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-token-'));
  dirs.push(root);
  const secret = ticketTokenSecret(root);
  assert.equal(statSync(path.join(root, 'runtime', 'ticket-token.key')).mode & 0o777, 0o600);
  // A restart reads the same secret, so agents already running keep theirs.
  assert.deepEqual(ticketTokenSecret(root), secret);
  const token = ticketToken(secret, 'execution-1');
  assert.ok(isTicketToken(secret, 'execution-1', token));
  assert.equal(isTicketToken(secret, 'execution-2', token), false);
  assert.equal(isTicketToken(secret, 'execution-1', `${token}x`), false);
  assert.equal(isTicketToken(secret, 'execution-1', ''), false);
});
