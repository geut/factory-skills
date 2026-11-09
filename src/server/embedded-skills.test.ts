import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EMBEDDED_SKILL_FILES, skillAssetKey, writeEmbeddedSkills } from './embedded-skills.ts';

const skills = path.resolve(import.meta.dirname, '..', '..', 'skills');

test('the executable carries every Markdown file of the review skill', () => {
  const directory = path.join(skills, 'factory-review');
  const markdown = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) =>
      path.relative(skills, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .toSorted();
  assert.deepEqual([...EMBEDDED_SKILL_FILES].toSorted(), markdown);
});

function asset(key: string): string {
  return `${key}\n`;
}

test('the carried skills are written out as they travel', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'factory-skills-'));
  try {
    assert.equal(writeEmbeddedSkills(directory, asset), directory);
    const [first] = EMBEDDED_SKILL_FILES;
    assert.equal(readFileSync(path.join(directory, first), 'utf8'), `${skillAssetKey(first)}\n`);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
