import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  SKILLS_MANIFEST_ASSET,
  skillAssetKey,
  skillFiles,
  writeEmbeddedSkills,
} from './embedded-skills.ts';

const skills = path.resolve(import.meta.dirname, '..', '..', 'skills');

test('the executable carries every stage skill and what it links to, but no tests', () => {
  const files = skillFiles(skills);
  for (const stage of [
    'factory-plan',
    'factory-work',
    'factory-qa',
    'factory-review',
    'factory-wrapup',
  ]) {
    assert.ok(files.includes(`${stage}/SKILL.md`), stage);
  }
  // factory-work links to ../prove-it-works/SKILL.md.
  assert.ok(files.includes('prove-it-works/SKILL.md'));
  assert.ok(files.includes('factory-review/scripts/review-packet.py'));
  assert.ok(files.every((file) => !/\.test\./.test(file) && !file.endsWith('.DS_Store')));
});

// Two skill files, each carrying its own asset key.
function asset(key: string): string {
  return key === SKILLS_MANIFEST_ASSET
    ? JSON.stringify(['factory-work/SKILL.md', 'prove-it-works/SKILL.md'])
    : `${key}\n`;
}

test('the carried skills are written out as the manifest lists them', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'factory-skills-'));
  try {
    assert.equal(writeEmbeddedSkills(directory, asset), directory);
    assert.equal(
      readFileSync(path.join(directory, 'prove-it-works/SKILL.md'), 'utf8'),
      `${skillAssetKey('prove-it-works/SKILL.md')}\n`,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
