import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The skills the single executable carries, by path under `skills/`: the ones
// a stage passes to Pi by path because it runs its agent untrusted, where an
// installed factory package's skills may not load. Only the files the skill's
// agent reads; a test checks the list against the directory.
export const EMBEDDED_SKILL_FILES = [
  'factory-review/SKILL.md',
  'factory-review/references/code-quality.md',
  'factory-review/references/output.md',
  'factory-review/references/review-contract.md',
  'factory-review/references/reviewer-prompt.md',
] as const;

// The asset key a skill file travels under.
export function skillAssetKey(file: string): string {
  return `skills/${file}`;
}

// Writes the carried skills into `directory`, each only when it changed, and
// returns it: the skills directory the executable's agents get.
export function writeEmbeddedSkills(directory: string, asset: (key: string) => string): string {
  for (const file of EMBEDDED_SKILL_FILES) {
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
