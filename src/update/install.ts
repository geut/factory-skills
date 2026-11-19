import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ghRun, runCommand } from '../ports/gh.ts';
import { RELEASES_REPO, versionOf } from './releases.ts';
import { writePreviousRecord } from './rollback.ts';

// Installing a release: download this machine's binary and its checksum,
// check one against the other, keep the running binary as `factory.previous`
// beside it, and swap the new one into place. Anything that fails before the
// swap leaves the binary as it was.

// The release asset for this machine, or why there is none.
export function binaryAsset(input: {
  arch: string;
  platform: string;
}): { asset: string; kind: 'ok' } | { kind: 'error'; message: string } {
  if (input.platform !== 'linux' || (input.arch !== 'arm64' && input.arch !== 'x64')) {
    return {
      kind: 'error',
      message: `Releases carry binaries for Linux arm64 and x64 only, not ${input.platform} ${input.arch}; build this one from source.`,
    };
  }
  return { asset: `factory-linux-${input.arch}`, kind: 'ok' };
}

export function previousPath(binary: string): string {
  return `${binary}.previous`;
}

// Downloads a release's `asset` and `asset.sha256` into `dir`.
export type Download = (input: { asset: string; dir: string; tag: string }) => Promise<void>;

export const ghDownload: Download = async (input) => {
  await ghRun(
    [
      'release',
      'download',
      input.tag,
      '--repo',
      RELEASES_REPO,
      '--pattern',
      input.asset,
      '--pattern',
      `${input.asset}.sha256`,
      '--dir',
      input.dir,
      '--clobber',
    ],
    '',
  );
};

export async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

// The version a binary reports with `--version`, or null when it cannot say.
export async function binaryVersion(binary: string): Promise<string | null> {
  try {
    return versionOf(
      await runCommand({ args: ['--version'], command: binary, stdin: '', timeoutMs: 30_000 }),
    );
  } catch {
    return null;
  }
}

export type InstallResult = { kind: 'error'; message: string } | { kind: 'installed' };

export async function installRelease(input: {
  arch: string;
  binary: string;
  download: Download;
  platform: string;
  // The running version and its database schema: what factory.previous will
  // be, for a rollback.
  running: { schema: number; version: string };
  version: string;
}): Promise<InstallResult> {
  const chosen = binaryAsset({ arch: input.arch, platform: input.platform });
  if (chosen.kind === 'error') {
    return chosen;
  }
  const { asset } = chosen;
  // Beside the binary, so the swap is a rename on one filesystem.
  let dir: string;
  try {
    dir = await mkdtemp(path.join(path.dirname(input.binary), '.factory-update-'));
  } catch (error: unknown) {
    return { kind: 'error', message: `Cannot write beside ${input.binary}: ${messageOf(error)}` };
  }
  try {
    try {
      await input.download({ asset, dir, tag: `v${input.version}` });
    } catch (error: unknown) {
      return {
        kind: 'error',
        message: `Cannot download factory ${input.version}: ${messageOf(error)}`,
      };
    }
    const downloaded = path.join(dir, asset);
    let expected: string;
    try {
      expected = (await readFile(`${downloaded}.sha256`, 'utf8')).trim().split(/\s+/)[0] ?? '';
    } catch (error: unknown) {
      return {
        kind: 'error',
        message: `factory ${input.version} came without its checksum: ${messageOf(error)}`,
      };
    }
    let actual: string;
    try {
      actual = await sha256Of(downloaded);
    } catch (error: unknown) {
      return {
        kind: 'error',
        message: `factory ${input.version} did not download whole: ${messageOf(error)}`,
      };
    }
    if (actual !== expected.toLowerCase()) {
      return {
        kind: 'error',
        message: `factory ${input.version} does not match its checksum, so it was not installed.`,
      };
    }
    try {
      await chmod(downloaded, 0o755);
      await copyFile(input.binary, previousPath(input.binary));
      writePreviousRecord(input.binary, input.running);
      await rename(downloaded, input.binary);
    } catch (error: unknown) {
      return {
        kind: 'error',
        message: `Cannot replace ${input.binary}: ${messageOf(error)}`,
      };
    }
    return { kind: 'installed' };
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
