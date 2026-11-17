import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { git, initRepo } from '../../../tests/git-repo.ts';
import { missingHeadings, prInstructions, readPrFormat, templateHeadings } from './pr-format.ts';

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const template = [
  '## What changed',
  '',
  '<!-- Describe the change.',
  '## Not a heading -->',
  '',
  '## How it was tested',
  '',
  '```md',
  '## Also not a heading',
  '```',
  '',
  '## Checklist',
  '',
  '- [ ] Tests added',
].join('\n');

test('a template’s headings skip comments and code; a body must have them all, in order', () => {
  const headings = templateHeadings(template);
  assert.deepEqual(headings, ['What changed', 'How it was tested', 'Checklist']);
  assert.deepEqual(
    missingHeadings(
      headings,
      '## What changed\nx\n### how it was tested\ny\n## Checklist\n- [x] Tests added',
    ),
    [],
  );
  assert.deepEqual(missingHeadings(headings, '## Checklist\n## What changed\n'), [
    'How it was tested',
    'Checklist',
  ]);
});

test('PR instructions are the section whose heading names pull requests', () => {
  const agents = [
    '# Project',
    '',
    '## Testing',
    'Run npm test.',
    '',
    '## Pull requests',
    'Start the body with a one-line summary.',
    '',
    '### Body',
    'Then a Testing section.',
    '',
    '## Releases',
    'Tag from main.',
  ].join('\n');
  assert.equal(
    prInstructions(agents),
    '## Pull requests\nStart the body with a one-line summary.\n\n### Body\nThen a Testing section.',
  );
  assert.equal(
    prInstructions('# Project\n\n## Opening PRs\nKeep them small.\n'),
    '## Opening PRs\nKeep them small.',
  );
  assert.equal(prInstructions('# Project\n\nNo PR rules here, only prose.\n'), null);
});

function repo(files: Record<string, string>): { codeRoot: string; sha: string } {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-pr-format-'));
  roots.push(codeRoot);
  initRepo(codeRoot);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(codeRoot, file)), { recursive: true });
    writeFileSync(path.join(codeRoot, file), text);
  }
  git(codeRoot, ['add', '-A']);
  git(codeRoot, ['commit', '--allow-empty', '-m', 'files']);
  return { codeRoot, sha: git(codeRoot, ['rev-parse', 'HEAD']) };
}

test('the format comes from the agent instructions, then a template, then the default, at the base commit', () => {
  const both = repo({
    '.github/PULL_REQUEST_TEMPLATE.md': template,
    'AGENTS.md': '## Pull requests\nUse the template, plus a Risk line.\n',
  });
  assert.deepEqual(readPrFormat(both), {
    kind: 'instructions',
    path: 'AGENTS.md',
    text: '## Pull requests\nUse the template, plus a Risk line.',
  });

  const templated = repo({ 'AGENTS.md': '# Rules\n', 'docs/pull_request_template.md': template });
  assert.deepEqual(readPrFormat(templated), {
    headings: ['What changed', 'How it was tested', 'Checklist'],
    kind: 'template',
    path: 'docs/pull_request_template.md',
    text: template,
  });

  assert.deepEqual(readPrFormat(repo({})), { kind: 'default' });

  // Only the base commit counts: a template the ticket adds later does not.
  const later = repo({});
  writeFileSync(path.join(later.codeRoot, 'pull_request_template.md'), template);
  git(later.codeRoot, ['add', '-A']);
  git(later.codeRoot, ['commit', '-m', 'add a template']);
  assert.deepEqual(readPrFormat(later), { kind: 'default' });
});

test('a hint on a heading’s line, or a fence inside a comment, does not change the headings', () => {
  assert.deepEqual(
    templateHeadings(['## Summary <!-- required -->', '<!--', '```', '-->', '## After'].join('\n')),
    ['Summary', 'After'],
  );
  // A body that drops the hint, as the prompt asks, has the heading.
  assert.deepEqual(missingHeadings(['Summary'], '## Summary\n\nKeeps the filter.'), []);
});

test('symlinked instructions and templates are read through their links', () => {
  const linked = repo({ 'CLAUDE.md': '# Rules\n\n## Pull requests\nLead with the risk.\n' });
  symlinkSync('CLAUDE.md', path.join(linked.codeRoot, 'AGENTS.md'));
  mkdirSync(path.join(linked.codeRoot, '.github'));
  writeFileSync(path.join(linked.codeRoot, 'TEMPLATE.md'), '## What changed\n');
  symlinkSync('../TEMPLATE.md', path.join(linked.codeRoot, '.github/pull_request_template.md'));
  git(linked.codeRoot, ['add', '-A']);
  git(linked.codeRoot, ['commit', '-m', 'links']);
  const sha = git(linked.codeRoot, ['rev-parse', 'HEAD']);
  assert.deepEqual(readPrFormat({ codeRoot: linked.codeRoot, sha }), {
    kind: 'instructions',
    path: 'AGENTS.md',
    text: '## Pull requests\nLead with the risk.',
  });
  // Without PR instructions, the linked template is read through its link.
  writeFileSync(path.join(linked.codeRoot, 'CLAUDE.md'), '# Rules\n');
  git(linked.codeRoot, ['commit', '-am', 'no PR rules']);
  const next = git(linked.codeRoot, ['rev-parse', 'HEAD']);
  assert.deepEqual(readPrFormat({ codeRoot: linked.codeRoot, sha: next }), {
    headings: ['What changed'],
    kind: 'template',
    path: '.github/pull_request_template.md',
    text: '## What changed\n',
  });
});
