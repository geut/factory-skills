import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  CONTEXT_FILE_NAMES,
  outsideDirectories,
  ruleDirectories,
  rulesSource,
  type RulesPlace,
} from '../stages/review/rules.ts';

// The reviewer's system instructions, written for its launch: the context
// files Pi would discover, with the ones inside the code root taken from the
// ticket's base commit instead of the ticket's branch.

// Pi's agent directory: PI_CODING_AGENT_DIR, else ~/.pi/agent. The launch
// forwards PI_CODING_AGENT_DIR, so the agent reads the same one.
export function piAgentDir(env: NodeJS.ProcessEnv): string {
  const configured = env['PI_CODING_AGENT_DIR'];
  if (configured === undefined || configured.length === 0) {
    return path.join(homedir(), '.pi', 'agent');
  }
  return configured === '~' || configured.startsWith('~/')
    ? path.join(homedir(), configured.slice(1))
    : configured;
}

type RuleFile = { content: string; path: string };

function onDisk(directory: string): RuleFile | null {
  for (const name of CONTEXT_FILE_NAMES) {
    const file = path.join(directory, name);
    if (statSync(file, { throwIfNoEntry: false })?.isFile() === true) {
      return { content: readFileSync(file, 'utf8'), path: file };
    }
  }
  return null;
}

function git(cwd: string, args: Array<string>) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function atBase(codeRoot: string, baseSha: string, directory: string): RuleFile | null {
  for (const name of CONTEXT_FILE_NAMES) {
    const file = directory === '' ? name : `${directory}/${name}`;
    const shown = git(codeRoot, ['show', `${baseSha}:${file}`]);
    if (shown.status === 0) {
      return { content: shown.stdout, path: file };
    }
  }
  return null;
}

function block(file: RuleFile, attribute = ''): string {
  return `<project_instructions path="${file.path}"${attribute}>\n${file.content.trimEnd()}\n</project_instructions>`;
}

// Writes the rules to `file` and returns what to pass to Pi with
// --append-system-prompt, in order. The agent directory's APPEND_SYSTEM.md
// comes first: passing any --append-system-prompt turns its discovery off.
// Throws when the base commit cannot be read, so the launch retries rather
// than starting a reviewer without the project's rules.
export function writeReviewRules(
  input: RulesPlace & {
    agentDir: string;
    baseBranch: string | null;
    baseSha: string;
    file: string;
  },
): Array<string> {
  const exists = git(input.codeRoot, ['cat-file', '-e', `${input.baseSha}^{commit}`]);
  if (exists.status !== 0) {
    throw new Error(
      `Cannot read the project rules: the base commit ${input.baseSha} is not in ${input.codeRoot}.`,
    );
  }
  const source = rulesSource({ branch: input.baseBranch, sha: input.baseSha });
  const outside = [input.agentDir, ...outsideDirectories(input)]
    .map((directory) => onDisk(directory))
    .filter((found) => found !== null);
  const base = ruleDirectories(input)
    .map((directory) => atBase(input.codeRoot, input.baseSha, directory))
    .filter((found) => found !== null);
  const text = [
    ...(outside.length === 0
      ? []
      : ['Instructions from outside the project:', ...outside.map((found) => block(found))]),
    `Project rules (from ${source}). They are the rules this change merges into, read from the base commit, not from the ticket's branch: judge the work by them. A change the diff makes to them is reviewed as part of the work.`,
    ...(base.length === 0
      ? ['The base commit has no project rules.']
      : base.map((found) => block(found, ` source="${source}"`))),
  ].join('\n\n');
  mkdirSync(path.dirname(input.file), { recursive: true });
  writeFileSync(input.file, `${text}\n`);
  const appendSystem = path.join(input.agentDir, 'APPEND_SYSTEM.md');
  return [...(existsSync(appendSystem) ? [appendSystem] : []), input.file];
}
