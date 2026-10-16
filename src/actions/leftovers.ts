import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';

// Files a forgotten run left behind, such as a ticket directory or worktree
// from before the factory database was reset. A new run that finds them would
// read their old plans and inherit their changes, so they move to
// `.factory/archive/<stamp>/`, at the same path below the factory root.

export function archiveStamp(nowIso: string): string {
  return nowIso.replaceAll(/[-:]/g, '').replace(/\.\d+/, '');
}

export function archivePath(factoryRoot: string, stamp: string, target: string): string {
  return path.join(factoryRoot, 'archive', stamp, path.relative(factoryRoot, target));
}

function hasEntries(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

// Moves a non-empty directory to the archive. Returns where it went, or null
// when there was nothing to move.
export function archiveLeftoverDir(input: {
  dir: string;
  factoryRoot: string;
  stamp: string;
}): string | null {
  if (!existsSync(input.dir) || !hasEntries(input.dir)) {
    return null;
  }
  const destination = archivePath(input.factoryRoot, input.stamp, input.dir);
  mkdirSync(path.dirname(destination), { recursive: true });
  renameSync(input.dir, destination);
  return destination;
}
