import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { renderVerificationSkill } from './write-verification-skill.mjs';

const roots = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

test.skip('verification skill names Launch, Drive, Evidence, and Surf for a web app', async () => {
  const code = await mkdtemp(path.join(tmpdir(), 'verify-code-'));
  const factory = await mkdtemp(path.join(tmpdir(), 'verify-factory-'));
  roots.push(code, factory);
  await writeFile(
    path.join(code, 'package.json'),
    `${JSON.stringify({ scripts: { dev: 'vite' } })}\n`,
  );
  await writeFile(path.join(code, 'pnpm-lock.yaml'), '');
  const rendered = renderVerificationSkill({ codeRoot: code, factoryRoot: factory, repo: 'demo' });
  const skill = rendered.files['SKILL.md'];
  assert.equal(rendered.web, true);
  assert.match(skill, /## Launch/);
  assert.match(skill, /## Doctor/);
  assert.match(skill, /## Drive/);
  assert.match(skill, /## Evidence/);
  assert.match(skill, /## Cleanup/);
  assert.match(skill, /pnpm dev/);
  assert.match(skill, /SURF_SESSION/);
  assert.match(skill, /session\.ensure/);
  assert.match(skill, /wait\.ready/);
  assert.match(skill, /--auto-capture/);
  assert.match(skill, /network\.stats/);
  assert.match(rendered.files['features/primary.md'], /Do not treat a green typecheck/);
});
