import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRetirement } from './retire.ts';

function client(name: string, closed: Array<string>) {
  return { close: () => closed.push(name) };
}

test('retired clients close at once when nothing runs', () => {
  const closed: Array<string> = [];
  createRetirement().retire([client('a', closed), client('b', closed)]);
  assert.deepEqual(closed, ['a', 'b']);
});

test('a command running when its session ends keeps its client until it finishes', async () => {
  const closed: Array<string> = [];
  const retirement = createRetirement();
  const command = Promise.withResolvers<string>();
  const running = retirement.tracked(() => command.promise);
  retirement.retire([client('a', closed)]);
  assert.deepEqual(closed, []);
  command.resolve('done');
  assert.equal(await running, 'done');
  assert.deepEqual(closed, ['a']);
});

test('a command that fails still lets retired clients close', async () => {
  const closed: Array<string> = [];
  const retirement = createRetirement();
  const running = retirement.tracked(() => Promise.reject(new Error('boom')));
  retirement.retire([client('a', closed)]);
  await assert.rejects(running, /boom/);
  assert.deepEqual(closed, ['a']);
});
