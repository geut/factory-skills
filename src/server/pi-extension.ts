import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The operator's Pi extension (/factory, the widget, the cards) travels in the
// single executable, which installs it into Pi's agent directory on every
// start: a factory release is one artifact, and updating the binary updates
// Pi too. Pi loads `extensions/<name>/index.js` on its next start or /reload.

export const PI_EXTENSION_ASSET = 'pi-extension.js';

export type PiExtensionInstall =
  // Pi already loads factory-skills from a package: its copy is left alone.
  { kind: 'package'; source: string } | { kind: 'unchanged' | 'written'; path: string };

function packagesIn(settingsFile: string): Array<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsFile, 'utf8'));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || !('packages' in parsed)) {
    return [];
  }
  const { packages } = parsed;
  if (!Array.isArray(packages)) {
    return [];
  }
  return packages.flatMap((item: unknown) => {
    if (typeof item === 'string') {
      return [item];
    }
    return typeof item === 'object' &&
      item !== null &&
      'source' in item &&
      typeof item.source === 'string'
      ? [item.source]
      : [];
  });
}

// The factory-skills package Pi loads for this repository, from the user's or
// the project's Pi settings, if any: `git:github.com/geut/factory-skills@v0.3.0`.
export function factoryPackage(input: { agentDir: string; codeRoot: string }): string | null {
  const sources = [
    ...packagesIn(path.join(input.codeRoot, '.pi', 'settings.json')),
    ...packagesIn(path.join(input.agentDir, 'settings.json')),
  ];
  return sources.find((source) => /(^|[/:@])factory-skills(?![\w-])/.test(source)) ?? null;
}

export function installPiExtension(input: {
  agentDir: string;
  codeRoot: string;
  source: string;
}): PiExtensionInstall {
  const installed = factoryPackage(input);
  if (installed !== null) {
    return { kind: 'package', source: installed };
  }
  const file = path.join(input.agentDir, 'extensions', 'factory', 'index.js');
  let current: string | null = null;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    // Not written yet.
  }
  if (current === input.source) {
    return { kind: 'unchanged', path: file };
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, input.source);
  return { kind: 'written', path: file };
}

// What the server says when a package install keeps its copy out of Pi.
export function packageHint(source: string): string {
  return `Pi loads factory-skills from ${source}, so this factory does not install its own Pi extension, and updates will not reach Pi. Run \`pi remove ${source}\` to let the factory keep Pi current.`;
}
