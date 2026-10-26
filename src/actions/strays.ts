import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';

// Servers an agent backgrounds in its worktree outlive its pane. Before a work
// or QA run, the controller stops the ones whose worktree no longer belongs to
// an active execution, so the next test harness neither collides with them nor
// reuses them.

// One of the user's processes. `factoryWorktree` is the FACTORY_WORKTREE a
// factory launch script exported, which every process it starts inherits: an
// agent's worktree, or a value outside the worktrees for a handoff pane.
export type ProcessInfo = {
  command: string;
  cwd: string | null;
  factoryWorktree: string | null;
  pid: number;
  ppid: number;
};

export type Stray = { process: ProcessInfo; worktree: string };

// The worktree that `target` lies in, under `worktreesDir` or its real path
// `realDir`, named under `worktreesDir`; or null.
function worktreeOf(worktreesDir: string, realDir: string, target: string): string | null {
  for (const dir of new Set([worktreesDir, realDir])) {
    const relative = path.relative(dir, path.resolve(target));
    const [slug] = relative.split(path.sep);
    if (relative !== '' && slug !== undefined && slug !== '..' && !path.isAbsolute(relative)) {
      return path.join(worktreesDir, slug);
    }
  }
  return null;
}

// The processes to stop: owned by a factory worktree that is not active, or
// whose directory is gone. A process with the marker is owned by what it
// names; one without, by its working directory. Anything else, and
// `protectedPids`, is kept.
export function strayProcesses(input: {
  activeWorktrees: ReadonlySet<string>;
  exists: (dir: string) => boolean;
  processes: ReadonlyArray<ProcessInfo>;
  protectedPids: ReadonlySet<number>;
  // The real path of `worktreesDir`, as /proc and lsof report working directories.
  realWorktreesDir?: string;
  worktreesDir: string;
}): Array<Stray> {
  const worktreesDir = path.resolve(input.worktreesDir);
  const realDir = path.resolve(input.realWorktreesDir ?? worktreesDir);
  const active = new Set([...input.activeWorktrees].map((dir) => path.resolve(dir)));
  const strays: Array<Stray> = [];
  for (const process of input.processes) {
    const owner = process.factoryWorktree ?? process.cwd;
    if (input.protectedPids.has(process.pid) || owner === null) {
      continue;
    }
    const worktree = worktreeOf(worktreesDir, realDir, owner);
    if (worktree !== null && (!active.has(worktree) || !input.exists(worktree))) {
      strays.push({ process, worktree });
    }
  }
  return strays;
}

const POLL_MS = 100;
// SIGKILL cannot be caught, so this only covers the kernel tearing it down.
const KILL_WAIT_MS = 1000;

export type SweepOutcome = {
  command: string;
  // The signal that stopped it, or why it could not be stopped.
  detail: string;
  kind: 'stray_process_stopped' | 'stray_process_stop_failed';
  pid: number;
  worktree: string;
};

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// SIGTERM every stray, give them `graceMs` to exit, then SIGKILL the rest.
// Each stray gets one outcome, recorded in the strays' order. Nothing here
// throws, so a failed sweep never holds up the run.
export async function sweepStrays(input: {
  alive: (pid: number) => boolean;
  graceMs: number;
  record: (outcome: SweepOutcome) => void;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  strays: ReadonlyArray<Stray>;
  wait: (ms: number) => Promise<void>;
}): Promise<Array<SweepOutcome>> {
  const outcomes = new Map<Stray, SweepOutcome>();
  const settle = (stray: Stray, kind: SweepOutcome['kind'], detail: string) => {
    outcomes.set(stray, {
      command: stray.process.command,
      detail,
      kind,
      pid: stray.process.pid,
      worktree: stray.worktree,
    });
  };
  // Sends `signal` to the strays not yet settled; a failure settles one.
  const send = (signal: NodeJS.Signals) => {
    for (const stray of input.strays.filter((item) => !outcomes.has(item))) {
      try {
        input.signal(stray.process.pid, signal);
      } catch (error: unknown) {
        if (errorCode(error) === 'ESRCH') {
          settle(stray, 'stray_process_stopped', signal);
        } else {
          settle(stray, 'stray_process_stop_failed', messageOf(error));
        }
      }
    }
  };
  // Waits up to `ms` for the unsettled strays to exit, settling those that did.
  const reap = async (signal: NodeJS.Signals, ms: number) => {
    for (let waited = 0; ; waited += POLL_MS) {
      for (const stray of input.strays.filter((item) => !outcomes.has(item))) {
        if (!input.alive(stray.process.pid)) {
          settle(stray, 'stray_process_stopped', signal);
        }
      }
      if (input.strays.every((item) => outcomes.has(item)) || waited >= ms) {
        return;
      }
      await input.wait(POLL_MS);
    }
  };
  send('SIGTERM');
  await reap('SIGTERM', input.graceMs);
  send('SIGKILL');
  await reap('SIGKILL', KILL_WAIT_MS);
  for (const stray of input.strays.filter((item) => !outcomes.has(item))) {
    settle(stray, 'stray_process_stop_failed', 'still running after SIGKILL');
  }
  const ordered = input.strays.flatMap((stray) => {
    const outcome = outcomes.get(stray);
    return outcome === undefined ? [] : [outcome];
  });
  for (const outcome of ordered) {
    try {
      input.record(outcome);
    } catch {
      // Recording is best effort; the sweep's result still returns.
    }
  }
  return ordered;
}

const MARKER = 'FACTORY_WORKTREE';

// The marker in a NUL-separated /proc environ, or null.
function markerIn(environ: string): string | null {
  const entry = environ.split('\0').find((item) => item.startsWith(`${MARKER}=`));
  const value = entry?.slice(MARKER.length + 1) ?? '';
  return value.length > 0 ? value : null;
}

function readOrNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

// Linux: the current user's processes from /proc. One that exits mid-read, or
// whose files are closed to us, comes back with what could be read.
function fromProc(uid: number): Array<ProcessInfo> {
  const processes: Array<ProcessInfo> = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) {
      continue;
    }
    const dir = `/proc/${name}`;
    if (readOrNull(() => statSync(dir).uid) !== uid) {
      continue;
    }
    // `pid (comm) state ppid …`; comm may hold spaces and parentheses.
    const stat = readOrNull(() => readFileSync(`${dir}/stat`, 'utf8')) ?? '';
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    const command = (readOrNull(() => readFileSync(`${dir}/cmdline`, 'utf8')) ?? '')
      .split('\0')
      .join(' ')
      .trim();
    if (command.length === 0) {
      continue;
    }
    processes.push({
      command,
      cwd: readOrNull(() => readlinkSync(`${dir}/cwd`)),
      factoryWorktree: markerIn(readOrNull(() => readFileSync(`${dir}/environ`, 'utf8')) ?? ''),
      pid: Number(name),
      ppid: Number.isInteger(ppid) ? ppid : 0,
    });
  }
  return processes;
}

// What a command printed. lsof exits 1 over warnings it still lists past, so
// the status is not checked; a command that cannot run prints nothing.
function commandOutput(command: string, args: Array<string>): string {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 }).stdout ?? '';
}

// `ps -E` appends the environment to the command, space-separated: the marker
// runs up to the next variable, so a path with spaces survives.
const psMarker = new RegExp(`^\\s*(\\d+)\\s.*\\s${MARKER}=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|$)`);

// Elsewhere (macOS): `ps` for the processes and their environment, `lsof` for
// their working directories.
function fromPs(uid: number): Array<ProcessInfo> {
  const markers = new Map<number, string>();
  // -ww: without a terminal, ps cuts lines at 80 columns, before the environment.
  for (const line of commandOutput('ps', [
    '-ww',
    '-E',
    '-U',
    String(uid),
    '-o',
    'pid=,command=',
  ]).split('\n')) {
    const match = psMarker.exec(line);
    if (match !== null && match[2] !== undefined && match[2].length > 0) {
      markers.set(Number(match[1]), match[2]);
    }
  }
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of commandOutput('lsof', ['-a', '-d', 'cwd', '-u', String(uid), '-Fpn']).split(
    '\n',
  )) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n')) {
      cwds.set(pid, line.slice(1));
    }
  }
  return commandOutput('ps', ['-ww', '-U', String(uid), '-o', 'pid=,ppid=,command='])
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (match === null) {
        return [];
      }
      const pid = Number(match[1]);
      return [
        {
          command: match[3]?.trim() ?? '',
          cwd: cwds.get(pid) ?? null,
          factoryWorktree: markers.get(pid) ?? null,
          pid,
          ppid: Number(match[2]),
        },
      ];
    });
}

// The current user's processes. Listing never throws: a platform it cannot
// read yields none, and the sweep then stops nothing.
export function listProcesses(): Array<ProcessInfo> {
  const uid = process.getuid?.() ?? null;
  if (uid === null) {
    return [];
  }
  return readOrNull(() => (process.platform === 'linux' ? fromProc(uid) : fromPs(uid))) ?? [];
}

// Whether `pid` still runs. A zombie has exited; only its entry is left.
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error: unknown) {
    return errorCode(error) === 'EPERM';
  }
  if (process.platform !== 'linux') {
    return true;
  }
  // `pid (comm) state …`: the state letter follows the last parenthesis.
  const stat = readOrNull(() => readFileSync(`/proc/${pid}/stat`, 'utf8'));
  return stat !== null && stat.charAt(stat.lastIndexOf(')') + 2) !== 'Z';
}
