import path from 'node:path';

// Where a ticket's generations live. The first is the ticket's own factory
// directory; a rerun's generation N lives in `<ticket dir>/r<N>`. The ticket
// key, used in API URLs, is the ticket directory's name, so it stays the same
// across reruns.

const GENERATION_DIR = /^r(\d+)$/;

export function ticketDirOf(factoryDir: string): string {
  return GENERATION_DIR.test(path.basename(factoryDir)) ? path.dirname(factoryDir) : factoryDir;
}

export function keyOfFactoryDir(factoryDir: string): string {
  return path.basename(ticketDirOf(factoryDir));
}

export function generationDir(ticketDir: string, generation: number): string {
  return generation <= 1 ? ticketDir : path.join(ticketDir, `r${generation}`);
}

// A rerun gets its own worktree and branch: `factory/<key>-r<N>`.
export function worktreeSlugFor(factoryDir: string, generation: number): string {
  const key = keyOfFactoryDir(factoryDir);
  return generation <= 1 ? key : `${key}-r${generation}`;
}

// The factory root a generation's directory sits in: `<root>/tickets/<key>[/r<N>]`.
export function factoryRootOf(factoryDir: string): string {
  return path.dirname(path.dirname(ticketDirOf(factoryDir)));
}
