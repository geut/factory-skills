import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// The operator's Pi extension (/factory, the widget, the cards) travels in the
// single executable, which installs it into Pi's agent directory on every
// start: a factory release is one artifact, and updating the binary updates
// Pi too. Pi loads `extensions/<name>/index.js` on its next start or /reload.
//
// The file is global to the machine, but whether Pi also loads factory-skills
// from a package depends on the project. So the binary always writes it, and
// the bundled copy decides when Pi loads it, per session: it steps aside
// where Pi's settings list a factory-skills package (see factoryPackage).

export const PI_EXTENSION_ASSET = 'pi-extension.js';

const PACKAGE_NAME = 'factory-skills';

// A package source Pi settings list, and where it is resolved from.
type Listed = { base: string; source: string };

function packagesIn(settingsFile: string): Array<Listed> {
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
  const base = path.dirname(settingsFile);
  return packages.flatMap((item: unknown) => {
    if (typeof item === 'string') {
      return [{ base, source: item }];
    }
    return typeof item === 'object' &&
      item !== null &&
      'source' in item &&
      typeof item.source === 'string'
      ? [{ base, source: item.source }]
      : [];
  });
}

// Whether a package source is factory-skills: a git source by its repository
// name, an npm source by its package name, and a local path by the name in its
// package.json, so a checkout or worktree under any directory name counts.
export function isFactoryPackage(listed: Listed): boolean {
  const { source } = listed;
  if (source.startsWith('npm:')) {
    // npm:factory-skills, npm:@scope/factory-skills, either with @version.
    const name = source.slice(4).replace(/(?<=.)@[^@/]*$/, '');
    return name === PACKAGE_NAME || name.endsWith(`/${PACKAGE_NAME}`);
  }
  if (/^(git:|https?:\/\/|ssh:\/\/|git@)/.test(source)) {
    // git:github.com/geut/factory-skills@v0.3.0, https://…/factory-skills.git
    const repo = source.replace(/@[^/@:]*$/, '').replace(/\.git$/, '');
    return repo.split(/[/:]/).at(-1) === PACKAGE_NAME;
  }
  const local =
    source === '~' || source.startsWith('~/')
      ? path.join(homedir(), source.slice(1))
      : path.resolve(listed.base, source);
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(local, 'package.json'), 'utf8'));
    return (
      typeof manifest === 'object' &&
      manifest !== null &&
      'name' in manifest &&
      manifest.name === PACKAGE_NAME
    );
  } catch {
    return false;
  }
}

// The factory-skills package Pi loads in `cwd`, from the project's or the
// user's Pi settings, if any: `git:github.com/geut/factory-skills@v0.3.0`.
export function factoryPackage(input: { agentDir: string; cwd: string }): string | null {
  const listed = [
    ...packagesIn(path.join(input.cwd, '.pi', 'settings.json')),
    ...packagesIn(path.join(input.agentDir, 'settings.json')),
  ];
  return listed.find((item) => isFactoryPackage(item))?.source ?? null;
}

// A git or npm source pins a release, so its copy never updates; a local
// checkout is someone working on the factory.
export function pinnedPackage(source: string): boolean {
  return /^(npm:|git:|https?:\/\/|ssh:\/\/|git@)/.test(source);
}

// Writes the extension where Pi loads it, only when it changed.
export function installPiExtension(input: { agentDir: string; source: string }): {
  kind: 'unchanged' | 'written';
  path: string;
} {
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

// What the server says when Pi loads a pinned factory-skills package here.
export function packageHint(source: string): string {
  return `Pi loads factory-skills from ${source}, so Pi keeps that version and factory updates will not reach it. Run \`pi remove ${source}\` to let the factory keep Pi current.`;
}

// What the server does on start: install the extension, warning instead of
// failing when Pi's agent directory cannot be written, and point out a pinned
// package that keeps Pi on its version here.
export function setUpPiExtension(input: {
  agentDir: string;
  codeRoot: string;
  out: (line: string) => void;
  source: string;
}): void {
  try {
    installPiExtension({ agentDir: input.agentDir, source: input.source });
  } catch (error: unknown) {
    input.out(
      `Warning: cannot install the factory's Pi extension in ${input.agentDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const installed = factoryPackage({ agentDir: input.agentDir, cwd: input.codeRoot });
  if (installed !== null && pinnedPackage(installed)) {
    input.out(packageHint(installed));
  }
}
