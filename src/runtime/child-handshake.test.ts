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
  replyIsMissing,
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

function assistant(...content: Array<Record<string, string>>) {
  return { message: { content, role: 'assistant' }, type: 'message' };
}

test('a reply without a template counts as missing, as in a wrap-up that only thought it through', () => {
  const user = {
    message: { content: [{ text: 'Follow the skill.', type: 'text' }], role: 'user' },
    type: 'message',
  };
  const done = { id: 'call-1', name: 'subagent_done', type: 'toolCall' };
  const template = '## Outcome\n\nDone.\n\n## Files\n\n- `goodbye.md`';
  // The wrap-up in the Herdr tabs check: chatter, then thinking and the call.
  assert.equal(
    replyIsMissing([
      user,
      assistant({ text: 'Let me verify the file content.', type: 'text' }),
      assistant({ thinking: 'Now I will write the template.', type: 'thinking' }, done),
    ]),
    true,
  );
  assert.equal(replyIsMissing([user, assistant(done)]), true);
  assert.equal(replyIsMissing([user, assistant({ text: template, type: 'text' }, done)]), false);
  assert.equal(
    replyIsMissing([user, assistant({ text: template, type: 'text' }), assistant(done)]),
    false,
  );
  // A template before the latest prompt does not answer it.
  assert.equal(
    replyIsMissing([user, assistant({ text: template, type: 'text' }), user, assistant(done)]),
    true,
  );
});
