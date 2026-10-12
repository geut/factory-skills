import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  afterFailedTurn,
  createTerminalWriter,
  NUDGE_DELAYS_MS,
  shouldAutoExit,
} from './child-handshake.ts';

test('the handshake writes the done sidecar once', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'factory-handshake-'));
  const sessionFile = path.join(directory, 'session.jsonl');
  const writeTerminal = createTerminalWriter();
  assert.equal(writeTerminal(sessionFile, { type: 'done' }), true);
  assert.equal(readFileSync(`${sessionFile}.exit`, 'utf8'), '{"type":"done"}');
  assert.equal(
    writeTerminal(sessionFile, { message: 'again', name: 'factory', type: 'ping' }),
    false,
  );
  assert.equal(readFileSync(`${sessionFile}.exit`, 'utf8'), '{"type":"done"}');
  assert.equal(writeTerminal(undefined, { type: 'done' }), false);
});

test('a caller ping sidecar keeps the question', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'factory-handshake-'));
  const sessionFile = path.join(directory, 'session.jsonl');
  const writeTerminal = createTerminalWriter();
  assert.equal(
    writeTerminal(sessionFile, { message: 'Which API?', name: 'review', type: 'ping' }),
    true,
  );
  assert.equal(
    readFileSync(`${sessionFile}.exit`, 'utf8'),
    '{"type":"ping","name":"review","message":"Which API?"}',
  );
});

test('auto-exit only follows a clean assistant turn', () => {
  assert.equal(shouldAutoExit([]), false);
  assert.equal(shouldAutoExit([{ role: 'user' }]), false);
  assert.equal(shouldAutoExit([{ role: 'assistant', stopReason: 'aborted' }]), false);
  assert.equal(shouldAutoExit([{ role: 'assistant', stopReason: 'error' }]), false);
  assert.equal(shouldAutoExit([{ role: 'assistant', stopReason: 'stop' }]), true);
  assert.equal(
    shouldAutoExit([{ role: 'assistant', stopReason: 'stop' }, { role: 'user' }]),
    false,
  );
});

test('a failed model request nudges the child with backoff, then exits', () => {
  const failed = [{ role: 'user' }, { role: 'assistant', stopReason: 'error' }];
  assert.deepEqual(afterFailedTurn(failed, 0), { delayMs: NUDGE_DELAYS_MS[0], kind: 'nudge' });
  assert.deepEqual(afterFailedTurn(failed, 2), { delayMs: NUDGE_DELAYS_MS[2], kind: 'nudge' });
  assert.deepEqual(afterFailedTurn(failed, NUDGE_DELAYS_MS.length), { kind: 'exit' });
  assert.deepEqual(afterFailedTurn([{ role: 'assistant', stopReason: 'stop' }], 3), {
    kind: 'none',
  });
  assert.deepEqual(afterFailedTurn([{ role: 'assistant', stopReason: 'aborted' }], 0), {
    kind: 'none',
  });
});
