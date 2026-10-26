import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  listProcesses,
  processAlive,
  strayProcesses,
  sweepStrays,
  type ProcessInfo,
  type SweepOutcome,
} from './strays.ts';

const worktrees = '/repo/.factory/worktrees';

function proc(pid: number, fields: Partial<ProcessInfo> = {}): ProcessInfo {
  return { command: `server ${pid}`, cwd: null, factoryWorktree: null, pid, ppid: 1, ...fields };
}

function strays(processes: Array<ProcessInfo>, gone: Array<string> = []) {
  return strayProcesses({
    activeWorktrees: new Set([`${worktrees}/proj-2`]),
    exists: (dir) => !gone.includes(dir),
    processes,
    protectedPids: new Set([99]),
    worktreesDir: worktrees,
  }).map((stray) => [stray.process.pid, stray.worktree]);
}

test('a process in an inactive worktree is stopped', () => {
  assert.deepEqual(strays([proc(10, { cwd: `${worktrees}/proj-1/packages/ui` })]), [
    [10, `${worktrees}/proj-1`],
  ]);
});

test('a process in an active worktree is kept', () => {
  assert.deepEqual(
    strays([
      proc(10, { cwd: `${worktrees}/proj-2` }),
      proc(11, { factoryWorktree: `${worktrees}/proj-2` }),
    ]),
    [],
  );
});

test('a process outside the factory is kept', () => {
  assert.deepEqual(
    strays([
      proc(10, { cwd: '/home/me/side-project' }),
      proc(11, { cwd: '/repo/.factory/worktrees-old/proj-1' }),
      proc(12),
    ]),
    [],
  );
});

test('a process whose worktree directory is gone is stopped, even if it was active', () => {
  assert.deepEqual(strays([proc(10, { cwd: `${worktrees}/proj-2` })], [`${worktrees}/proj-2`]), [
    [10, `${worktrees}/proj-2`],
  ]);
});

test('an orphan known only by its marker is stopped', () => {
  assert.deepEqual(
    strays([proc(10, { cwd: '/', factoryWorktree: `${worktrees}/proj-1`, ppid: 1 })]),
    [[10, `${worktrees}/proj-1`]],
  );
});

test('the marker decides the owner over the working directory', () => {
  // Started by proj-2's agent, it later moved into proj-1's tree.
  assert.deepEqual(
    strays([proc(10, { cwd: `${worktrees}/proj-1`, factoryWorktree: `${worktrees}/proj-2` })]),
    [],
  );
});

test('a marker outside the worktrees keeps a process wherever it runs', () => {
  // A handoff pane left open on a finished ticket's worktree.
  assert.deepEqual(
    strays([proc(10, { cwd: `${worktrees}/proj-1`, factoryWorktree: 'handoff' })]),
    [],
  );
});

test('a working directory under the real path of the worktrees counts', () => {
  // /proc reports resolved paths; the factory root may sit behind a symlink.
  assert.deepEqual(
    strayProcesses({
      activeWorktrees: new Set(),
      exists: () => true,
      processes: [proc(10, { cwd: '/private/repo/.factory/worktrees/proj-1/app' })],
      protectedPids: new Set(),
      realWorktreesDir: '/private/repo/.factory/worktrees',
      worktreesDir: worktrees,
    }).map((stray) => [stray.process.pid, stray.worktree]),
    [[10, `${worktrees}/proj-1`]],
  );
});

test('the factory server and its parent are never stopped', () => {
  assert.deepEqual(strays([proc(99, { cwd: `${worktrees}/proj-1` })]), []);
});

// A process table where each pid dies on the signals in `diesOn`; `refuses`
// pids throw EPERM.
function fakeSystem(diesOn: Record<number, Array<NodeJS.Signals>>, refuses: Array<number> = []) {
  const alive = new Set(Object.keys(diesOn).map(Number));
  const sent: Array<[number, NodeJS.Signals]> = [];
  return {
    alive: (pid: number) => alive.has(pid),
    sent,
    signal: (pid: number, signal: NodeJS.Signals) => {
      if (refuses.includes(pid)) {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      sent.push([pid, signal]);
      if (diesOn[pid]?.includes(signal)) {
        alive.delete(pid);
      }
    },
  };
}

async function sweep(system: ReturnType<typeof fakeSystem>, pids: Array<number>) {
  const recorded: Array<SweepOutcome> = [];
  const outcomes = await sweepStrays({
    alive: system.alive,
    graceMs: 50,
    record: (outcome) => recorded.push(outcome),
    signal: system.signal,
    strays: pids.map((pid) => ({ process: proc(pid), worktree: `${worktrees}/proj-1` })),
    wait: () => Promise.resolve(),
  });
  assert.deepEqual(outcomes, recorded);
  return outcomes.map((outcome) => [outcome.kind, outcome.pid, outcome.detail]);
}

test('the sweep stops politely first and forces only what outlives the grace period', async () => {
  const system = fakeSystem({ 10: ['SIGTERM'], 11: ['SIGKILL'] });
  assert.deepEqual(await sweep(system, [10, 11]), [
    ['stray_process_stopped', 10, 'SIGTERM'],
    ['stray_process_stopped', 11, 'SIGKILL'],
  ]);
  assert.deepEqual(system.sent, [
    [10, 'SIGTERM'],
    [11, 'SIGTERM'],
    [11, 'SIGKILL'],
  ]);
});

test('a sweep that cannot stop a process records the failure and does not throw', async () => {
  const system = fakeSystem({ 10: [], 11: [] }, [11]);
  assert.deepEqual(await sweep(system, [10, 11]), [
    ['stray_process_stop_failed', 10, 'still running after SIGKILL'],
    ['stray_process_stop_failed', 11, 'operation not permitted'],
  ]);
});

test('a process already gone when signalled counts as stopped', async () => {
  const system = fakeSystem({});
  assert.deepEqual(await sweep(system, [10]), [['stray_process_stopped', 10, 'SIGTERM']]);
});

test(
  'a server left in an inactive worktree is found and stopped',
  { skip: process.platform !== 'linux' && 'reads /proc' },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'factory-strays-'));
    const worktreesDir = path.join(root, 'worktrees');
    const worktree = path.join(worktreesDir, 'proj-1');
    mkdirSync(worktree, { recursive: true });
    // Started from elsewhere: only the marker ties it to the worktree.
    const child = spawn('sleep', ['30'], {
      cwd: root,
      env: { ...process.env, FACTORY_WORKTREE: worktree },
      stdio: 'ignore',
    });
    try {
      const pid = child.pid ?? -1;
      const listed = listProcesses().find((item) => item.pid === pid);
      assert.equal(listed?.factoryWorktree, worktree);
      assert.equal(listed?.cwd, root);
      assert.match(listed?.command ?? '', /^sleep 30/);
      const strays = strayProcesses({
        activeWorktrees: new Set(),
        exists: existsSync,
        processes: listProcesses(),
        protectedPids: new Set([process.pid]),
        worktreesDir,
      });
      assert.deepEqual(
        strays.map((stray) => stray.process.pid),
        [pid],
      );
      const outcomes = await sweepStrays({
        alive: processAlive,
        graceMs: 2000,
        record: () => undefined,
        signal: (target, signal) => process.kill(target, signal),
        strays,
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      assert.deepEqual(
        outcomes.map((outcome) => [outcome.kind, outcome.detail]),
        [['stray_process_stopped', 'SIGTERM']],
      );
      assert.equal(processAlive(pid), false);
    } finally {
      child.kill('SIGKILL');
      rmSync(root, { force: true, recursive: true });
    }
  },
);
