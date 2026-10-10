import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowsEmptyDiff, DEFAULT_COMMAND_TIMEOUT_MS, parseFactoryConfig } from './config.ts';

const models = { review: 'review-model', work: 'work-model' };

test('work commands default to 60 seconds and keep a longer timeout', () => {
  const parsed = parseFactoryConfig({
    models,
    validation: {
      work: {
        commands: [
          { argv: ['npm', 'test'], name: 'tests' },
          { argv: ['npm', 'run', 'lint'], name: 'lint', timeoutMs: 300_000 },
        ],
      },
    },
  });
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') {
    return;
  }
  assert.equal(parsed.config.validation.work.commands[0]?.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
  assert.equal(parsed.config.validation.work.commands[1]?.timeoutMs, 300_000);
  assert.equal(parsed.config.limits.workCorrections, 3);
});

test('label map accepts investigation and rejects unknown internal labels', () => {
  const parsed = parseFactoryConfig({
    labels: { map: { spike: 'investigation' } },
    models,
  });
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') {
    return;
  }
  assert.equal(allowsEmptyDiff(['spike'], parsed.config.labels.map), true);
  assert.equal(allowsEmptyDiff(['investigation'], {}), true);
  assert.equal(allowsEmptyDiff(['bug'], parsed.config.labels.map), false);
  assert.equal(parseFactoryConfig({ labels: { map: { spike: 'feature' } }, models }).kind, 'error');
});

test('review limits default to 3 and reviewRounds needs at least one round', () => {
  const parsed = parseFactoryConfig({ limits: { reviewCorrections: 0 }, models });
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') {
    return;
  }
  assert.equal(parsed.config.limits.reviewRounds, 3);
  assert.equal(parsed.config.limits.reviewCorrections, 0);
  assert.equal(parseFactoryConfig({ limits: { reviewRounds: 0 }, models }).kind, 'error');
  assert.equal(parseFactoryConfig({ limits: { reviewRounds: 1.5 }, models }).kind, 'error');
});
