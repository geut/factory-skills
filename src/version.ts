import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The factory's version as stats record it: the package version and the commit
// it was built from, such as `0.1.0+1ddf4f6`. The single executable has it
// baked in at build time; source runs ask git.
declare const FACTORY_BUILD_VERSION: string | undefined;

let cached: string | null = null;

export function factoryVersion(): string {
  if (cached !== null) {
    return cached;
  }
  if (typeof FACTORY_BUILD_VERSION === 'string') {
    cached = FACTORY_BUILD_VERSION;
    return cached;
  }
  cached = sourceVersion(path.resolve(import.meta.dirname, '..'));
  return cached;
}

export function sourceVersion(packageRoot: string): string {
  let version = '0.0.0';
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
      version = String(manifest.version);
    }
  } catch {
    // No manifest next to the source.
  }
  const sha = spawnSync('git', ['-C', packageRoot, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
  });
  const dirty = spawnSync(
    'git',
    ['-C', packageRoot, 'status', '--porcelain', '--untracked-files=no'],
    {
      encoding: 'utf8',
    },
  );
  if (sha.status !== 0) {
    return version;
  }
  const changed = dirty.status === 0 && dirty.stdout.trim().length > 0 ? '-dirty' : '';
  return `${version}+${sha.stdout.trim()}${changed}`;
}
