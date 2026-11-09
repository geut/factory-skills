import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { piAgentDir, writeReviewRules } from './review-rules.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function git(cwd: string, args: Array<string>): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

// A code root with three versions of AGENTS.md: the base commit's, the
// ticket branch's in its worktree, and a stale one in the operator's checkout.
// A context file sits above the code root, and the agent directory has its own.
// `base` adds files to the base commit; a `link:` value makes a symlink.
function fixture(base: Record<string, string> = {}) {
  const top = realpathSync(mkdtempSync(path.join(tmpdir(), 'factory-rules-')));
  roots.push(top);
  writeFileSync(path.join(top, 'CLAUDE.md'), 'Outside: the sandbox rules.\n');
  const codeRoot = path.join(top, 'app');
  mkdirSync(codeRoot);
  git(codeRoot, ['init', '-q', '-b', 'main']);
  git(codeRoot, ['config', 'user.email', 'factory@example.com']);
  git(codeRoot, ['config', 'user.name', 'Factory']);
  const files: Record<string, string> = {
    'AGENTS.md': 'Base: tests never touch the network.\n',
    ...base,
  };
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(codeRoot, file);
    mkdirSync(path.dirname(target), { recursive: true });
    rmSync(target, { force: true });
    if (content.startsWith('link:')) {
      symlinkSync(content.slice('link:'.length), target);
    } else {
      writeFileSync(target, content);
    }
  }
  git(codeRoot, ['add', '.']);
  git(codeRoot, ['commit', '-q', '-m', 'base']);
  const baseSha = git(codeRoot, ['rev-parse', 'HEAD']);
  const worktree = path.join(codeRoot, '.factory', 'worktrees', 'eng-42');
  git(codeRoot, ['worktree', 'add', '-q', '-b', 'factory/eng-42', worktree, baseSha]);
  writeFileSync(path.join(worktree, 'AGENTS.md'), 'Ticket: tests may call the network.\n');
  writeFileSync(path.join(codeRoot, 'AGENTS.md'), 'Stale: an old checkout.\n');
  const agentDir = path.join(top, 'agent');
  mkdirSync(agentDir);
  writeFileSync(path.join(agentDir, 'AGENTS.md'), 'Agent: global rules.\n');
  return {
    agentDir,
    baseSha,
    codeRoot,
    prefix: path.join(top, 'sessions', 'run'),
    top,
    worktree,
  };
}

function rulesText(value: { prefix: string }): string {
  return readFileSync(`${value.prefix}.rules.md`, 'utf8');
}

test('the reviewer gets the base commit’s rules, not the ticket branch’s or the checkout’s', () => {
  const value = fixture();
  const prompts = writeReviewRules({ ...value, baseBranch: 'main' });
  assert.deepEqual(prompts, {
    appendSystemPrompt: [`${value.prefix}.rules.md`],
    systemPrompt: null,
  });
  const text = rulesText(value);
  assert.match(text, /Project rules \(from main at [0-9a-f]{7}\)/);
  assert.match(
    text,
    /<project_instructions path="AGENTS\.md" source="main at [0-9a-f]{7}">\nBase: tests never touch the network\.\n/,
  );
  assert.doesNotMatch(text, /Ticket: tests may call the network/);
  assert.doesNotMatch(text, /Stale: an old checkout/);
  // Context files outside the code root still reach the reviewer, as on disk.
  assert.match(text, new RegExp(`path="${value.agentDir}/AGENTS\\.md">\\nAgent: global rules\\.`));
  assert.match(
    text,
    new RegExp(`path="${value.top}/CLAUDE\\.md">\\nOutside: the sandbox rules\\.`),
  );
  assert.ok(text.indexOf('Agent: global rules') < text.indexOf('Outside: the sandbox rules'));
  assert.ok(text.indexOf('Outside: the sandbox rules') < text.indexOf('Base: tests never'));
});

test('the agent directory’s APPEND_SYSTEM.md comes first, since passing rules turns its discovery off', () => {
  const value = fixture();
  const appendSystem = path.join(value.agentDir, 'APPEND_SYSTEM.md');
  writeFileSync(appendSystem, 'Always answer in English.\n');
  assert.deepEqual(writeReviewRules({ ...value, baseBranch: 'main' }).appendSystemPrompt, [
    appendSystem,
    `${value.prefix}.rules.md`,
  ]);
});

test('the base commit’s .pi prompt files replace the ticket branch’s and the agent directory’s APPEND_SYSTEM.md', () => {
  const value = fixture({
    '.pi/APPEND_SYSTEM.md': 'Base append.\n',
    '.pi/SYSTEM.md': 'Base system.\n',
  });
  writeFileSync(path.join(value.agentDir, 'APPEND_SYSTEM.md'), 'Global append.\n');
  writeFileSync(path.join(value.worktree, '.pi', 'SYSTEM.md'), 'Ticket system.\n');
  const prompts = writeReviewRules({ ...value, baseBranch: 'main' });
  assert.deepEqual(prompts, {
    appendSystemPrompt: [`${value.prefix}.append-system.md`, `${value.prefix}.rules.md`],
    systemPrompt: `${value.prefix}.system.md`,
  });
  assert.equal(readFileSync(`${value.prefix}.system.md`, 'utf8'), 'Base system.\n');
  assert.equal(readFileSync(`${value.prefix}.append-system.md`, 'utf8'), 'Base append.\n');
});

test('a symlinked rule file is read through its link at the base commit', () => {
  const value = fixture({
    'AGENTS.md': 'link:docs/RULES.md',
    'docs/RULES.md': 'Linked: name every fixture.\n',
  });
  writeFileSync(
    path.join(value.worktree, 'docs', 'RULES.md'),
    'Ticket: fixtures may be anonymous.\n',
  );
  writeReviewRules({ ...value, baseBranch: 'main' });
  const text = rulesText(value);
  assert.match(
    text,
    /path="AGENTS\.md" source="main at [0-9a-f]{7}">\nLinked: name every fixture\./,
  );
  assert.doesNotMatch(text, /Ticket: fixtures may be anonymous/);
});

test('a directory between the code root and the worktree gives its tracked rules, else its rules on disk', () => {
  const untracked = fixture();
  writeFileSync(
    path.join(untracked.codeRoot, '.factory', 'AGENTS.md'),
    'Factory: run the e2e suite.\n',
  );
  writeReviewRules({ ...untracked, baseBranch: 'main' });
  assert.match(
    rulesText(untracked),
    new RegExp(
      `path="${untracked.codeRoot}/\\.factory/AGENTS\\.md">\\nFactory: run the e2e suite\\.`,
    ),
  );
  const tracked = fixture({ '.factory/AGENTS.md': 'Tracked: run the unit suite.\n' });
  writeFileSync(path.join(tracked.codeRoot, '.factory', 'AGENTS.md'), 'Edited: skip the suite.\n');
  writeReviewRules({ ...tracked, baseBranch: 'main' });
  const text = rulesText(tracked);
  assert.match(
    text,
    /path="\.factory\/AGENTS\.md" source="main at [0-9a-f]{7}">\nTracked: run the unit suite\./,
  );
  assert.doesNotMatch(text, /Edited: skip the suite/);
});

test('a code root reached through a symlink is still the project, not outside it', () => {
  const value = fixture();
  const link = path.join(value.top, 'link');
  symlinkSync(value.top, link);
  writeReviewRules({ ...value, baseBranch: 'main', codeRoot: path.join(link, 'app') });
  assert.doesNotMatch(rulesText(value), /Stale: an old checkout/);
});

test('a base commit without rules says so, and an unknown base commit fails the launch', () => {
  const value = fixture();
  git(value.codeRoot, ['rm', '-q', '--cached', 'AGENTS.md']);
  git(value.codeRoot, ['commit', '-q', '-m', 'drop the rules']);
  const bare = git(value.codeRoot, ['rev-parse', 'HEAD']);
  writeReviewRules({ ...value, baseBranch: null, baseSha: bare });
  assert.match(
    rulesText(value),
    /Project rules \(from the base commit [0-9a-f]{7}\)[^\n]*\n\nThe base commit has no project rules\./,
  );
  assert.throws(
    () => writeReviewRules({ ...value, baseBranch: 'main', baseSha: 'f'.repeat(40) }),
    /the base commit f{40} is not in/,
  );
});

test('the agent directory is PI_CODING_AGENT_DIR, else ~/.pi/agent', () => {
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: '/opt/pi' }), '/opt/pi');
  assert.match(piAgentDir({}), /\.pi\/agent$/);
  assert.match(piAgentDir({ PI_CODING_AGENT_DIR: '~/pi-agent' }), /[^~]\/pi-agent$/);
});
