import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOsMetadata } from './os-metadata.ts';

test('OS metadata is Finder, AppleDouble, and Windows Explorer files at any depth', () => {
  for (const file of [
    '.DS_Store',
    '.factory/.DS_Store',
    'docs/._README.md',
    'img/Thumbs.db',
    'desktop.ini',
  ]) {
    assert.ok(isOsMetadata(file), file);
  }
  for (const file of ['README.md', 'src/.DS_Store.ts', 'docs/_notes.md', '.factory/CONTEXT.md']) {
    assert.ok(!isOsMetadata(file), file);
  }
});
