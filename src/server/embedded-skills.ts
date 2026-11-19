import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isOsMetadata } from '../os-metadata.ts';

// The skills the single executable carries: every file under `skills/` an
// agent may read, so a factory needs no Pi package for its stages. The build
// embeds each file as an asset, plus a manifest listing them, since a running
// executable cannot list its assets.

export const SKILLS_MANIFEST_ASSET = 'skills/manifest.json';

// The asset key a skill file travels under.
export function skillAssetKey(file: string): string {
  return `skills/${file}`;
}

// The files under `skillsRoot` to carry, as `factory-work/SKILL.md`: every
// file but tests and OS metadata.
export function skillFiles(skillsRoot: string): Array<string> {
  return readdirSync(skillsRoot, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && !isOsMetadata(entry.name) && !/\.test\.\w+$/.test(entry.name),
    )
    .map((entry) =>
      path.relative(skillsRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .toSorted();
}

// Writes the carried skills into `directory`, each only when it changed, and
// returns it: the skills directory the executable's agents get.
export function writeEmbeddedSkills(directory: string, asset: (key: string) => string): string {
  const listed: unknown = JSON.parse(asset(SKILLS_MANIFEST_ASSET));
  const files = Array.isArray(listed)
    ? listed.filter((item): item is string => typeof item === 'string')
    : [];
  for (const file of files) {
    const target = path.join(directory, file);
    const source = asset(skillAssetKey(file));
    let current: string | null = null;
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      // Not written yet.
    }
    if (current !== source) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
  }
  return directory;
}
