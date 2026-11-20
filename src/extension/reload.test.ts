import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fauxProvider } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import factoryExtension from './index.ts';

// The operator extension in a real Pi session, across /reload: Pi replaces the
// extension and marks the old one's context stale, so the old one's timers
// must stop rather than touch it.

const dirs: Array<string> = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('after /reload, the replaced extension’s poll never touches its stale context', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'factory-reload-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, '.factory'));
  const agentDir = path.join(dir, 'agent');
  const faux = fauxProvider({ models: [{ id: 'faux-1' }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const loader = new DefaultResourceLoader({
    agentDir,
    cwd: dir,
    extensionFactories: [factoryExtension],
    noExtensions: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    agentDir,
    cwd: dir,
    model: faux.getModel(),
    modelRuntime,
    noTools: 'builtin',
    resourceLoader: loader,
    sessionManager: SessionManager.create(dir, path.join(dir, 'sessions')),
    settingsManager: SettingsManager.inMemory(),
  });
  const crashes: Array<unknown> = [];
  const record = (error: unknown): void => {
    crashes.push(error);
  };
  process.on('uncaughtException', record);
  try {
    await session.bindExtensions({});
    await session.reload();
    // Past a poll tick of the replaced extension.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } finally {
    process.off('uncaughtException', record);
    session.dispose();
  }
  assert.deepEqual(
    crashes.map((error) => (error instanceof Error ? error.message : String(error))),
    [],
  );
});
