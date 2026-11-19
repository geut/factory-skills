import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { factoryPackage, installPiExtension, packageHint } from './pi-extension.ts';

const dirs: Array<string> = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function place() {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-pi-ext-'));
  dirs.push(root);
  const agentDir = path.join(root, 'agent');
  const codeRoot = path.join(root, 'repo');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(codeRoot, { recursive: true });
  return { agentDir, codeRoot };
}

test('the extension is written where Pi loads it, and rewritten only when it changes', () => {
  const { agentDir, codeRoot } = place();
  const file = path.join(agentDir, 'extensions', 'factory', 'index.js');
  assert.deepEqual(installPiExtension({ agentDir, codeRoot, source: 'v1' }), {
    kind: 'written',
    path: file,
  });
  const written = statSync(file).mtimeMs;
  assert.deepEqual(installPiExtension({ agentDir, codeRoot, source: 'v1' }), {
    kind: 'unchanged',
    path: file,
  });
  assert.equal(statSync(file).mtimeMs, written);
  assert.equal(installPiExtension({ agentDir, codeRoot, source: 'v2' }).kind, 'written');
  assert.equal(readFileSync(file, 'utf8'), 'v2');
});

test('a factory-skills package, personal or project, keeps the extension out and is named', () => {
  const { agentDir, codeRoot } = place();
  writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({
      packages: ['npm:@acme/pi-tools', 'git:github.com/geut/factory-skills@v0.3.0'],
    }),
  );
  assert.deepEqual(installPiExtension({ agentDir, codeRoot, source: 'v1' }), {
    kind: 'package',
    source: 'git:github.com/geut/factory-skills@v0.3.0',
  });
  assert.match(
    packageHint('git:github.com/geut/factory-skills@v0.3.0'),
    /Run `pi remove git:github\.com\/geut\/factory-skills@v0\.3\.0`/,
  );
  const project = place();
  mkdirSync(path.join(project.codeRoot, '.pi'));
  writeFileSync(
    path.join(project.codeRoot, '.pi', 'settings.json'),
    JSON.stringify({ packages: [{ source: '../factory-skills' }] }),
  );
  assert.equal(factoryPackage(project), '../factory-skills');
  // Another package with the word in a longer name is not it.
  writeFileSync(
    path.join(project.codeRoot, '.pi', 'settings.json'),
    JSON.stringify({ packages: ['npm:factory-skills-extras'] }),
  );
  assert.equal(factoryPackage(project), null);
});
