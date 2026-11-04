import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CommandRunner } from './pi-herdr.ts';

// The factory's own Herdr plugin. Its one pane entrypoint runs the script named
// by FACTORY_LAUNCH_SCRIPT as the pane's process, through non-interactive bash,
// so no shell setup in the pane runs before it or swallows the launch.
export const HERDR_PLUGIN_ID = 'geut.factory';
export const HERDR_PLUGIN_ENTRYPOINT = 'argv';
export const LAUNCH_SCRIPT_ENV = 'FACTORY_LAUNCH_SCRIPT';

export const herdrPluginManifest = `id = "${HERDR_PLUGIN_ID}"
name = "Factory"
version = "1"
# The first Herdr release with split plugin panes.
min_herdr_version = "0.8.2"
description = "Opens factory agent and handoff panes"
platforms = ["linux", "macos"]

[[panes]]
id = "${HERDR_PLUGIN_ENTRYPOINT}"
title = "Factory"
placement = "split"
command = ["bash", "-c", "exec bash \\"$${LAUNCH_SCRIPT_ENV}\\""]
`;

// Herdr registers plugins for the whole user, so the plugin lives in one place
// per user, not in a factory root that may be deleted.
export function herdrPluginDir(env: NodeJS.ProcessEnv): string {
  const dataHome = env['XDG_DATA_HOME'];
  const base =
    dataHome !== undefined && path.isAbsolute(dataHome)
      ? dataHome
      : path.join(env['HOME'] ?? homedir(), '.local', 'share');
  return path.join(base, 'factory', 'herdr-plugin');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function herdrPluginLinkArgs(dir: string): Array<string> {
  return ['plugin', 'link', dir];
}

function writeManifest(dir: string): void {
  const file = path.join(dir, 'herdr-plugin.toml');
  let current: string | null = null;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // Not written yet.
  }
  if (current !== herdrPluginManifest) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, herdrPluginManifest);
  }
}

// Writes the manifest and links it on every start. Linking replaces any earlier
// registration, enabled, and rereads the manifest, so a disabled plugin, one
// linked from elsewhere, or an older manifest all end up current.
export async function ensureHerdrPlugin(input: {
  dir: string;
  run: CommandRunner;
}): Promise<{ kind: 'ok' } | { kind: 'error'; message: string }> {
  try {
    writeManifest(input.dir);
  } catch (error: unknown) {
    return {
      kind: 'error',
      message: `Cannot write the factory's Herdr plugin: ${messageOf(error)}`,
    };
  }
  let linked: Awaited<ReturnType<CommandRunner>>;
  try {
    linked = await input.run(herdrPluginLinkArgs(input.dir));
  } catch (error: unknown) {
    linked = { code: 1, stderr: messageOf(error), stdout: '' };
  }
  if (linked.code !== 0) {
    const reason = linked.stderr.trim() || linked.stdout.trim() || `exit code ${linked.code}`;
    return {
      kind: 'error',
      message: `Cannot register the factory's Herdr plugin: ${reason}. Run: herdr ${herdrPluginLinkArgs(input.dir).join(' ')}`,
    };
  }
  return { kind: 'ok' };
}
