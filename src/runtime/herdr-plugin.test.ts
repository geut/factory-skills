import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { ensureHerdrPlugin, herdrPluginDir, herdrPluginManifest } from './herdr-plugin.ts';

const roots: Array<string> = [];
const linked = async () => ({ code: 0, stderr: '', stdout: '' });

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function pluginDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-herdr-plugin-'));
  roots.push(root);
  return path.join(root, 'factory', 'herdr-plugin');
}

test('the plugin lives in the user data home', () => {
  assert.equal(
    herdrPluginDir({ HOME: '/home/a', XDG_DATA_HOME: '/data' }),
    '/data/factory/herdr-plugin',
  );
  assert.equal(herdrPluginDir({ HOME: '/home/a' }), '/home/a/.local/share/factory/herdr-plugin');
  // A relative XDG_DATA_HOME is invalid by the spec and ignored.
  assert.equal(
    herdrPluginDir({ HOME: '/home/a', XDG_DATA_HOME: 'data' }),
    '/home/a/.local/share/factory/herdr-plugin',
  );
});

test('the argv pane runs the launch script through non-interactive bash', () => {
  assert.match(herdrPluginManifest, /^id = "geut\.factory"$/m);
  assert.match(herdrPluginManifest, /^id = "argv"$/m);
  assert.match(herdrPluginManifest, /^placement = "split"$/m);
  assert.match(
    herdrPluginManifest,
    /^command = \["bash", "-c", "exec bash \\"\$FACTORY_LAUNCH_SCRIPT\\""\]$/m,
  );
});

test('ensureHerdrPlugin writes the manifest and links its directory', async () => {
  const dir = pluginDir();
  const calls: Array<Array<string>> = [];
  const result = await ensureHerdrPlugin({
    dir,
    run: async (args) => {
      calls.push(args);
      return { code: 0, stderr: '', stdout: '{}' };
    },
  });
  assert.deepEqual(result, { kind: 'ok' });
  assert.equal(readFileSync(path.join(dir, 'herdr-plugin.toml'), 'utf8'), herdrPluginManifest);
  assert.deepEqual(calls, [['plugin', 'link', dir]]);
});

test('ensureHerdrPlugin rewrites a stale manifest and leaves a current one alone', async () => {
  const dir = pluginDir();
  await ensureHerdrPlugin({ dir, run: linked });
  const file = path.join(dir, 'herdr-plugin.toml');
  const written = statSync(file).mtimeMs;
  await ensureHerdrPlugin({ dir, run: linked });
  assert.equal(statSync(file).mtimeMs, written);

  writeFileSync(file, 'id = "old"\n');
  await ensureHerdrPlugin({ dir, run: linked });
  assert.equal(readFileSync(file, 'utf8'), herdrPluginManifest);
});

test('a failed link names the command to run by hand', async () => {
  const dir = pluginDir();
  const result = await ensureHerdrPlugin({
    dir,
    run: async () => ({ code: 1, stderr: 'plugin_manifest_parse_failed\n', stdout: '' }),
  });
  assert.equal(result.kind, 'error');
  assert.match(
    result.kind === 'error' ? result.message : '',
    new RegExp(`plugin_manifest_parse_failed\\. Run: herdr plugin link ${dir}$`),
  );
});

test('a herdr that cannot start is a failed link, not a throw', async () => {
  const result = await ensureHerdrPlugin({
    dir: pluginDir(),
    run: () => Promise.reject(new Error('spawn herdr ENOENT')),
  });
  assert.equal(result.kind, 'error');
  assert.match(result.kind === 'error' ? result.message : '', /spawn herdr ENOENT/);
});
