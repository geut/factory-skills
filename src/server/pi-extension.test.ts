import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { factoryPackage, installPiExtension, setUpPiExtension } from './pi-extension.ts';

const dirs: Array<string> = [];
after(() => {
  for (const dir of dirs) {
    chmodSync(dir, 0o755);
    rmSync(dir, { force: true, recursive: true });
  }
});

function place() {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-pi-ext-'));
  dirs.push(root);
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'repo');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { agentDir, cwd, root };
}

test('the extension is written where Pi loads it, and rewritten only when it changes', () => {
  const { agentDir } = place();
  const file = path.join(agentDir, 'extensions', 'factory', 'index.js');
  assert.deepEqual(installPiExtension({ agentDir, source: 'v1' }), { kind: 'written', path: file });
  const written = statSync(file).mtimeMs;
  assert.deepEqual(installPiExtension({ agentDir, source: 'v1' }), {
    kind: 'unchanged',
    path: file,
  });
  assert.equal(statSync(file).mtimeMs, written);
  assert.equal(installPiExtension({ agentDir, source: 'v2' }).kind, 'written');
  assert.equal(readFileSync(file, 'utf8'), 'v2');
});

// Pi settings at `file` listing `packages`.
function settings(file: string, packages: Array<unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ packages }));
}

test('a factory-skills package is known by what it is, wherever Pi lists it', () => {
  const { agentDir, cwd, root } = place();
  assert.equal(factoryPackage({ agentDir, cwd }), null);
  for (const source of [
    'git:github.com/geut/factory-skills@v0.3.0',
    'https://github.com/geut/factory-skills.git',
    'npm:@geut/factory-skills@0.5.0',
  ]) {
    settings(path.join(agentDir, 'settings.json'), ['npm:@acme/pi-tools', source]);
    assert.equal(factoryPackage({ agentDir, cwd }), source, source);
  }
  settings(path.join(agentDir, 'settings.json'), [
    'npm:factory-skills-extras',
    'git:github.com/acme/other',
  ]);
  assert.equal(factoryPackage({ agentDir, cwd }), null);
  // A checkout under another directory name, listed by the project, counts by
  // its package.json.
  const checkout = path.join(root, 'work', 'feat-x');
  mkdirSync(checkout, { recursive: true });
  writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'factory-skills' }));
  settings(path.join(cwd, '.pi', 'settings.json'), [{ source: '../../work/feat-x' }]);
  assert.equal(factoryPackage({ agentDir, cwd }), '../../work/feat-x');
  // Another project on the same machine has none.
  const other = path.join(root, 'other');
  mkdirSync(other);
  assert.equal(factoryPackage({ agentDir, cwd: other }), null);
});

test('setting up the extension warns instead of failing, and names a pinned package', () => {
  const { agentDir, cwd } = place();
  const out: Array<string> = [];
  chmodSync(agentDir, 0o555);
  setUpPiExtension({ agentDir, codeRoot: cwd, out: (line) => out.push(line), source: 'v1' });
  chmodSync(agentDir, 0o755);
  assert.match(out[0] ?? '', /^Warning: cannot install the factory's Pi extension in .*: EACCES/);
  writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ packages: ['git:github.com/geut/factory-skills@v0.3.0'] }),
  );
  out.length = 0;
  setUpPiExtension({ agentDir, codeRoot: cwd, out: (line) => out.push(line), source: 'v1' });
  // Written all the same: the bundled copy steps aside in Pi itself.
  assert.equal(
    readFileSync(path.join(agentDir, 'extensions', 'factory', 'index.js'), 'utf8'),
    'v1',
  );
  assert.match(out.join('\n'), /Run `pi remove git:github\.com\/geut\/factory-skills@v0\.3\.0`/);
});
