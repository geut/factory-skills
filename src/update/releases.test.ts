import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, updateFrom, versionOf } from './releases.ts';

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  draft: false,
  html_url: `https://github.com/geut/factory-skills/releases/tag/${tag}`,
  name: tag,
  prerelease: false,
  tag_name: tag,
  ...extra,
});

test('a version is read from a tag or a build version, and nothing else', () => {
  assert.equal(versionOf('v0.5.0'), '0.5.0');
  assert.equal(versionOf('0.5.0+1ddf4f6-dirty'), '0.5.0');
  assert.equal(versionOf('nightly'), null);
  assert.ok(compareVersions('0.10.0', '0.9.1') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('one newer release links its notes', () => {
  assert.deepEqual(updateFrom([release('v0.5.0'), release('v0.4.0')], '0.4.0'), {
    name: 'v0.5.0',
    notesUrl: 'https://github.com/geut/factory-skills/releases/tag/v0.5.0',
    version: '0.5.0',
  });
});

test('skipped releases name only the newest, and link the compare page from the running version', () => {
  const update = updateFrom(
    [release('v0.5.0'), release('v0.6.0', { name: 'Factory updates itself' }), release('v0.4.1')],
    '0.4.0',
  );
  assert.deepEqual(update, {
    name: 'Factory updates itself',
    notesUrl: 'https://github.com/geut/factory-skills/compare/v0.4.0...v0.6.0',
    version: '0.6.0',
  });
});

test('drafts and pre-releases are never an update, and the newest release is none', () => {
  const listed = [
    release('v0.7.0', { draft: true }),
    release('v0.6.0-rc.1', { prerelease: true }),
    release('v0.5.0'),
  ];
  assert.equal(updateFrom(listed, '0.5.0'), null);
  assert.equal(updateFrom(listed, '0.4.0')?.version, '0.5.0');
});

test('an unnamed release goes by its version, and an unexpected answer fails the check', () => {
  assert.equal(updateFrom([release('v0.5.0', { name: null })], '0.4.0')?.name, 'v0.5.0');
  assert.throws(() => updateFrom({ message: 'Not Found' }, '0.4.0'), /unexpected shape/);
});
