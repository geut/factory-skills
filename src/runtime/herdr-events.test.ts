import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { connectHerdrEvents } from './herdr-events.ts';

test('the herdr socket delivers pane.exited for the watched pane', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'factory-herdr-'));
  const socketPath = path.join(directory, 'herdr.sock');
  const server = createServer((sock) => {
    sock.on('data', (chunk) => {
      const request = JSON.parse(chunk.toString('utf8')) as { id?: string };
      sock.write(
        `${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`,
      );
      sock.write(
        `${JSON.stringify({ data: { pane_id: 'pane-1', type: 'pane_exited' }, event: 'pane_exited' })}\n`,
      );
      sock.write(
        `${JSON.stringify({ data: { pane_id: 'pane-2', type: 'pane_closed' }, event: 'pane_closed' })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(socketPath, () => {
      resolve();
    });
  });
  const stream = connectHerdrEvents({ socketPath });
  const seen: Array<string> = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('pane event did not arrive'));
      }, 2000);
      stream.watch('pane-1', (event) => {
        seen.push(`${event.event}:${event.paneId}`);
        clearTimeout(timer);
        resolve();
      });
    });
    assert.deepEqual(seen, ['pane_exited:pane-1']);
  } finally {
    stream.close();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    rmSync(directory, { force: true, recursive: true });
  }
});
