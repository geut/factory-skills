import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTerminalWriter, shouldAutoExit } from './child-handshake.ts';

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
