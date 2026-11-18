import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCommandBoard } from './command-progress.ts';

test('the board keeps each action’s current command until it reports none', () => {
  let clock = 0;
  const board = createCommandBoard(() => `t${(clock += 1)}`);
  const validation = board.reporter('a1');
  assert.equal(board.get('a1'), null);
  validation({ command: 'lint', index: 1, total: 2 });
  validation({ command: 'test', index: 2, total: 2 });
  assert.deepEqual(board.get('a1'), { command: 'test', index: 2, startedAt: 't2', total: 2 });
  // Another action's commands are its own.
  board.reporter('a2')({ command: 'install', index: 1, total: 1 });
  assert.equal(board.get('a2')?.command, 'install');
  validation(null);
  assert.equal(board.get('a1'), null);
  assert.equal(board.get('a2')?.command, 'install');
});
