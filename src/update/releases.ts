import { z } from 'zod';
import type { GhJson } from '../ports/gh.ts';

// Factory releases on GitHub, and whether one is an update (GLOSSARY.md): a
// stable release newer than the one this factory runs. Drafts and pre-releases
// never count.

export const RELEASES_REPO = 'geut/factory-skills';

const GithubRelease = z.object({
  draft: z.boolean(),
  html_url: z.string(),
  name: z.string().nullable(),
  prerelease: z.boolean(),
  tag_name: z.string(),
});

export type Release = { name: string; notesUrl: string; version: string };

// `0.5.0` from `v0.5.0`, `0.5.0+1ddf4f6`, or `0.5.0`; null for anything else.
export function versionOf(text: string): string | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[+-].*)?$/.exec(text.trim());
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

// The newest stable release newer than `current`, with where to read what
// changed: its notes, or the compare page when releases were skipped. Null
// when `current` is the newest.
export function updateFrom(payload: unknown, current: string): Release | null {
  const parsed = z.array(GithubRelease).safeParse(payload);
  if (!parsed.success) {
    throw new Error('GitHub answered the releases list in an unexpected shape.');
  }
  const newer = parsed.data
    .filter((release) => !release.draft && !release.prerelease)
    .flatMap((release) => {
      const version = versionOf(release.tag_name);
      return version === null ? [] : [{ ...release, version }];
    })
    .filter((release) => compareVersions(release.version, current) > 0)
    .toSorted((left, right) => compareVersions(right.version, left.version));
  const latest = newer[0];
  if (latest === undefined) {
    return null;
  }
  return {
    name: latest.name?.trim() || `v${latest.version}`,
    notesUrl:
      newer.length === 1
        ? latest.html_url
        : `https://github.com/${RELEASES_REPO}/compare/v${current}...${latest.tag_name}`,
    version: latest.version,
  };
}

// Asks GitHub, through gh, for the update to `current`, if any.
export async function checkForUpdate(input: {
  current: string;
  gh: GhJson;
}): Promise<Release | null> {
  const payload = await input.gh(['api', `repos/${RELEASES_REPO}/releases?per_page=30`]);
  return updateFrom(payload, input.current);
}
