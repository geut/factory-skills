// Builds dist/factory, a single executable for this platform that runs
// `factory serve`. See https://nodejs.org/api/single-executable-applications.html
//
// Node 24 runs one CommonJS script inside the executable, so esbuild bundles
// src/cli.ts into one file. Files the code reads next to itself travel as
// assets. The executable is a copy of the node running this script with the
// bundle injected, so build it on the OS and architecture that will run it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { SKILLS_MANIFEST_ASSET, skillAssetKey, skillFiles } from '../src/server/embedded-skills.ts';
import { PI_EXTENSION_ASSET } from '../src/server/pi-extension.ts';
import { sourceVersion } from '../src/version.ts';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const bundle = path.join(dist, 'factory.cjs');
const blob = path.join(dist, 'sea-prep.blob');
const config = path.join(dist, 'sea-config.json');
const executable = path.join(dist, process.platform === 'win32' ? 'factory.exe' : 'factory');
const macos = process.platform === 'darwin';

rmSync(dist, { force: true, recursive: true });
mkdirSync(dist);

await build({
  // CommonJS has no import.meta; source runs use it to find files next to them.
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  bundle: true,
  define: {
    FACTORY_BUILD_VERSION: JSON.stringify(sourceVersion(root)),
    'import.meta.url': '__importMetaUrl',
  },
  entryPoints: [path.join(root, 'src', 'cli.ts')],
  format: 'cjs',
  legalComments: 'none',
  outfile: bundle,
  platform: 'node',
  target: 'node24',
});

// The operator's Pi extension (/factory, the widget, the cards), as one ES
// module the binary writes into Pi's agent directory. Pi provides its own
// packages to extensions, so they stay external.
const piExtension = path.join(dist, 'pi-extension.js');
await build({
  bundle: true,
  define: { FACTORY_BUILD_VERSION: JSON.stringify(sourceVersion(root)) },
  entryPoints: [path.join(root, 'src', 'extension', 'index.ts')],
  external: ['@earendil-works/*', 'typebox'],
  format: 'esm',
  legalComments: 'none',
  outfile: piExtension,
  platform: 'node',
  target: 'node24',
});

// Every skill file travels, with a manifest the executable lists them from.
const carriedSkills = skillFiles(path.join(root, 'skills'));
const skillsManifest = path.join(dist, 'skills-manifest.json');
writeFileSync(skillsManifest, JSON.stringify(carriedSkills));

writeFileSync(
  config,
  JSON.stringify(
    {
      assets: {
        'child-handshake.ts': path.join(root, 'src', 'runtime', 'child-handshake.ts'),
        [PI_EXTENSION_ASSET]: piExtension,
        'schema.sql': path.join(root, 'src', 'state', 'schema.sql'),
        [SKILLS_MANIFEST_ASSET]: skillsManifest,
        ...Object.fromEntries(
          carriedSkills.map((file) => [skillAssetKey(file), path.join(root, 'skills', file)]),
        ),
      },
      disableExperimentalSEAWarning: true,
      // node:sqlite still warns that it is experimental on every start.
      execArgv: ['--disable-warning=ExperimentalWarning'],
      main: bundle,
      output: blob,
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

copyFileSync(process.execPath, executable);
if (macos) {
  execFileSync('codesign', ['--remove-signature', executable], { stdio: 'inherit' });
}
execFileSync(
  path.join(root, 'node_modules', '.bin', 'postject'),
  [
    executable,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(macos ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ],
  { stdio: 'inherit' },
);
if (macos) {
  execFileSync('codesign', ['--sign', '-', executable], { stdio: 'inherit' });
}
rmSync(blob);
rmSync(config);
process.stdout.write(`Built ${path.relative(root, executable)}\n`);
