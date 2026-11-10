import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  candidatePath,
  CONTEXT_FILE_NAMES,
  outsideDirectories,
  PROMPT_FILES,
  ruleDirectories,
  rulesSource,
  type RulesPlace,
} from '../stages/review/rules.ts';

// The reviewer's system instructions, written for its launch: the context
// files and `.pi` prompt files Pi would discover, with the ones inside the code
// root taken from the ticket's base commit instead of the ticket's branch.

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

// A file's text, following symlinks as Pi does, or null when it is not a file.
function fileText(file: string): string | null {
  return statSync(file, { throwIfNoEntry: false })?.isFile() === true
    ? readFileSync(file, 'utf8')
    : null;
}

function onDisk(directory: string): RuleFile | null {
  for (const name of CONTEXT_FILE_NAMES) {
    const file = path.join(directory, name);
    const content = fileText(file);
    if (content !== null) {
      return { content, path: file };
    }
  }
  return null;
}

function git(cwd: string, args: Array<string>, input?: string) {
  return spawnSync('git', ['--literal-pathspecs', ...args], {
    cwd,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

type TreeEntry = { mode: string; object: string; type: string };

// The base commit's entries for `paths`, by path, from one `git ls-tree`.
function treeEntries(codeRoot: string, sha: string, paths: Array<string>): Map<string, TreeEntry> {
  const listed = git(codeRoot, ['ls-tree', '-z', '--full-tree', `${sha}^{commit}`, '--', ...paths]);
  if (listed.status !== 0) {
    throw new Error(
      `Cannot read the project rules: the base commit ${sha} is not in ${codeRoot} (${listed.stderr.toString().trim()}).`,
    );
  }
  const entries = new Map<string, TreeEntry>();
  for (const record of listed.stdout.toString('utf8').split('\0')) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(record);
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      entries.set(match[4] ?? '', { mode: match[1], object: match[3], type: match[2] });
    }
  }
  return entries;
}

// The blobs' contents, by object id, from one `git cat-file --batch`.
function blobContents(codeRoot: string, objects: Array<string>): Map<string, string> {
  const contents = new Map<string, string>();
  if (objects.length === 0) {
    return contents;
  }
  const read = git(codeRoot, ['cat-file', '--batch'], `${objects.join('\n')}\n`);
  if (read.status !== 0) {
    throw new Error(`Cannot read the project rules: ${read.stderr.toString().trim()}`);
  }
  const output = read.stdout;
  let at = 0;
  while (at < output.length) {
    const end = output.indexOf(0x0a, at);
    const header = output.subarray(at, end < 0 ? output.length : end).toString('utf8');
    const match = /^([0-9a-f]+) \w+ (\d+)$/.exec(header);
    if (match?.[1] === undefined || match[2] === undefined || end < 0) {
      // `<object> missing`: nothing follows its header.
      at = end < 0 ? output.length : end + 1;
      continue;
    }
    const size = Number(match[2]);
    contents.set(match[1], output.subarray(end + 1, end + 1 + size).toString('utf8'));
    at = end + 1 + size + 1;
  }
  return contents;
}

// Reads paths at the base commit, a batch at a time, and keeps what it read.
function baseReader(codeRoot: string, sha: string) {
  const entries = new Map<string, TreeEntry | null>();
  const contents = new Map<string, string>();
  const load = (paths: Array<string>) => {
    const missing = paths.filter((file) => !entries.has(file));
    if (missing.length === 0) {
      return;
    }
    const listed = treeEntries(codeRoot, sha, missing);
    for (const file of missing) {
      entries.set(file, listed.get(file) ?? null);
    }
    const blobs = [...listed.values()]
      .filter((entry) => entry.type === 'blob' && !contents.has(entry.object))
      .map((entry) => entry.object);
    for (const [object, content] of blobContents(codeRoot, blobs)) {
      contents.set(object, content);
    }
  };
  return {
    content: (entry: TreeEntry) => contents.get(entry.object) ?? '',
    entry: (file: string) => {
      load([file]);
      return entries.get(file) ?? null;
    },
    load,
  };
}

type BaseReader = ReturnType<typeof baseReader>;

const SYMLINK = '120000';
const SYMLINK_HOPS = 8;

// A path's text at the base commit, following symlinks there as Pi follows
// them on disk; null when it is not a file. A link that leaves the repository
// is read from disk, from `root`, where Pi would find it.
function baseText(reader: BaseReader, file: string, root: string, hops = 0): string | null {
  const entry = reader.entry(file);
  if (entry === null || entry.type !== 'blob') {
    return null;
  }
  if (entry.mode !== SYMLINK) {
    return reader.content(entry);
  }
  if (hops >= SYMLINK_HOPS) {
    return null;
  }
  const link = reader.content(entry);
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), link));
  if (path.posix.isAbsolute(link) || target === '..' || target.startsWith('../')) {
    return fileText(path.resolve(root, path.posix.dirname(file), link));
  }
  return baseText(reader, target, root, hops + 1);
}

function candidates(directory: string): Array<string> {
  return CONTEXT_FILE_NAMES.map((name) => candidatePath(directory, name));
}

function firstAtBase(reader: BaseReader, directory: string, root: string): RuleFile | null {
  for (const file of candidates(directory)) {
    const content = baseText(reader, file, root);
    if (content !== null) {
      return { content, path: file };
    }
  }
  return null;
}

function block(file: RuleFile, attribute = ''): string {
  return `<project_instructions path="${file.path}"${attribute}>\n${file.content.trimEnd()}\n</project_instructions>`;
}

function diskBlock(directory: string): string | null {
  const found = onDisk(directory);
  return found === null ? null : block(found);
}

function realPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

// What to pass to Pi: --system-prompt when the base commit has a
// `.pi/SYSTEM.md`, else null for Pi's own (global) one, and the files for
// --append-system-prompt, in order.
export type ReviewPrompts = { appendSystemPrompt: Array<string>; systemPrompt: string | null };

// Writes the rules beside `prefix` (`<prefix>.rules.md`, and the base commit's
// `.pi` prompt files) and returns what to pass to Pi. Passing any
// --append-system-prompt turns APPEND_SYSTEM.md discovery off, so the one Pi
// would pick comes first: the base commit's, else the agent directory's.
// Inside the code root, the worktree's own directory takes the base commit's
// files; a directory between the code root and the worktree, such as
// `.factory`, takes them when the base commit tracks one, else from disk,
// since the operator keeps them there. Throws when the base commit cannot be
// read, so the review pauses rather than starting a reviewer without the
// project's rules.
export function writeReviewRules(
  input: RulesPlace & {
    agentDir: string;
    baseBranch: string | null;
    baseSha: string;
    prefix: string;
  },
): ReviewPrompts {
  // Which directories hold the project's rules is decided on the paths as
  // given, as the review prompt, its validation, and the handoff decide which
  // rule files a diff changes. The directories outside the project are the
  // ones Pi walks up through, from its real working directory.
  const place = { codeRoot: path.resolve(input.codeRoot), worktree: path.resolve(input.worktree) };
  const real = { codeRoot: realPath(input.codeRoot), worktree: realPath(input.worktree) };
  const reader = baseReader(place.codeRoot, input.baseSha);
  const source = rulesSource({ branch: input.baseBranch, sha: input.baseSha });
  const directories = ruleDirectories(place);
  reader.load([...PROMPT_FILES, ...directories.flatMap((directory) => candidates(directory))]);
  const outside = [input.agentDir, ...outsideDirectories(real)]
    .map((directory) => onDisk(directory))
    .filter((found) => found !== null);
  const fromBase = (directory: string, root: string) => {
    const found = firstAtBase(reader, directory, root);
    return found === null ? null : block(found, ` source="${source}"`);
  };
  const base = directories
    .map((directory) => {
      if (directory === '') {
        return fromBase(directory, place.worktree);
      }
      const tracked = candidates(directory).some((file) => reader.entry(file) !== null);
      return tracked
        ? fromBase(directory, place.codeRoot)
        : diskBlock(path.join(place.codeRoot, directory));
    })
    .filter((found) => found !== null);
  const text = [
    ...(outside.length === 0
      ? []
      : ['Instructions from outside the project:', ...outside.map((found) => block(found))]),
    `Project rules (from ${source}). They are the rules this change merges into, read from the base commit, not from the ticket's branch: judge the work by them. A change the diff makes to them is reviewed as part of the work.`,
    ...(base.length === 0 ? ['The base commit has no project rules.'] : base),
  ].join('\n\n');
  mkdirSync(path.dirname(input.prefix), { recursive: true });
  const rulesFile = `${input.prefix}.rules.md`;
  writeFileSync(rulesFile, `${text}\n`);
  const written = (suffix: string, content: string | null) => {
    if (content === null) {
      return null;
    }
    const file = `${input.prefix}.${suffix}`;
    writeFileSync(file, content);
    return file;
  };
  const [systemFile, appendFile] = PROMPT_FILES;
  const system = written('system.md', baseText(reader, systemFile, place.worktree));
  const globalAppend = path.join(input.agentDir, 'APPEND_SYSTEM.md');
  const append =
    written('append-system.md', baseText(reader, appendFile, place.worktree)) ??
    (existsSync(globalAppend) ? globalAppend : null);
  return {
    appendSystemPrompt: [...(append === null ? [] : [append]), rulesFile],
    systemPrompt: system,
  };
}
