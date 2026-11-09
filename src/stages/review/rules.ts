import path from 'node:path';
import type { TaskId, TaskRecord } from '../../domain.ts';
import { inside } from '../../paths.ts';

// The project's rules are the context files Pi loads into an agent's system
// prompt: one per directory, from the agent's working directory up. The
// reviewer takes the ones inside the code root from the ticket's base commit,
// so the ticket under review cannot change the rules it is judged by.

// Pi's names for a context file, in the order it picks the first one present.
export const CONTEXT_FILE_NAMES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
] as const;

// Where an agent runs and which repository holds its rules.
export type RulesPlace = { codeRoot: string; worktree: string };

// The repository directories, outermost first, whose context file Pi would
// load for an agent in `worktree`: the repository root, which is the
// worktree's own root, and each directory between the code root and the
// worktree, such as `.factory`. `''` is the root.
export function ruleDirectories(place: RulesPlace): Array<string> {
  const between: Array<string> = [];
  let directory = path.dirname(path.resolve(place.worktree));
  const codeRoot = path.resolve(place.codeRoot);
  while (directory !== codeRoot && inside(codeRoot, directory)) {
    between.unshift(path.relative(codeRoot, directory).split(path.sep).join('/'));
    directory = path.dirname(directory);
  }
  return ['', ...between];
}

// The directories above the worktree that are outside the code root, outermost
// first. Their context files are not the repository's, so they reach the
// reviewer as they are on disk.
export function outsideDirectories(place: RulesPlace): Array<string> {
  const outside: Array<string> = [];
  const codeRoot = path.resolve(place.codeRoot);
  let directory = path.dirname(path.resolve(place.worktree));
  while (true) {
    if (!inside(codeRoot, directory)) {
      outside.unshift(directory);
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return outside;
    }
    directory = parent;
  }
}

// A context file's repository path in `directory` (`''` is the root).
export function candidatePath(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`;
}

// Every repository path that could hold a rule file for an agent in `place`.
export function ruleCandidates(place: RulesPlace): Array<string> {
  return ruleDirectories(place).flatMap((directory) =>
    CONTEXT_FILE_NAMES.map((name) => candidatePath(directory, name)),
  );
}

// Pi's prompt files in the project's `.pi` directory, at the worktree root:
// SYSTEM.md replaces the system prompt and APPEND_SYSTEM.md adds to it. The
// reviewer takes them from the base commit too.
export const PROMPT_FILES = ['.pi/SYSTEM.md', '.pi/APPEND_SYSTEM.md'] as const;

// Whether a repository path names a rule file, at any depth.
export function isRulePath(file: string): boolean {
  const name = file.split('/').at(-1) ?? '';
  return (
    CONTEXT_FILE_NAMES.some((rule) => rule === name) ||
    PROMPT_FILES.some((prompt) => prompt === file)
  );
}

// The rule files among `paths`, repository-relative: the prompt files, then
// the context files in the order Pi reads them. Adding, removing, or editing
// any candidate changes the rules, since an added `AGENTS.override.md`
// shadows the `AGENTS.md` beside it.
export function changedRules(place: RulesPlace, paths: Iterable<string>): Array<string> {
  const changed = new Set(paths);
  return [...PROMPT_FILES, ...ruleCandidates(place)].filter((candidate) => changed.has(candidate));
}

// The rule changes earlier tasks' reviews accepted: each rule file's diff
// hash when a review of another task approved it, the latest task's last.
export function acceptedRules(
  tasks: ReadonlyArray<TaskRecord>,
  taskId: TaskId | null,
): Map<string, { hash: string; taskId: TaskId }> {
  const accepted = new Map<string, { hash: string; taskId: TaskId }>();
  for (const task of tasks.toSorted((a, b) => a.ordinal - b.ordinal)) {
    if (task.taskId === taskId) {
      continue;
    }
    for (const [file, hash] of Object.entries(task.summaries.review?.rules ?? {})) {
      accepted.set(file, { hash, taskId: task.taskId });
    }
  }
  return accepted;
}

// Splits the rule files a diff changes into those this task's review judges
// and those an earlier task's review accepted, unchanged since. The diff
// holds every task's changes until wrap-up commits them, so an accepted
// change stays in it.
export function ruleChanges(input: {
  accepted: Map<string, { hash: string; taskId: TaskId }>;
  changed: ReadonlyArray<string>;
  hashes: Record<string, string>;
}): { accepted: Array<{ file: string; taskId: TaskId }>; judged: Array<string> } {
  const accepted: Array<{ file: string; taskId: TaskId }> = [];
  const judged: Array<string> = [];
  for (const file of input.changed) {
    const earlier = input.accepted.get(file);
    if (earlier !== undefined && earlier.hash === input.hashes[file]) {
      accepted.push({ file, taskId: earlier.taskId });
    } else {
      judged.push(file);
    }
  }
  return { accepted, judged };
}

// The diff hash of each rule file among `changed`, for an approving review to
// record.
export function ruleHashes(
  changed: ReadonlyArray<string>,
  hashes: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    changed.flatMap((file) => {
      const hash = hashes[file];
      return hash === undefined ? [] : [[file, hash]];
    }),
  );
}

// Where the reviewer's rules came from, as its system prompt and the review
// validation name it.
export function rulesSource(base: { branch: string | null; sha: string }): string {
  const short = base.sha.slice(0, 7);
  return base.branch === null ? `the base commit ${short}` : `${base.branch} at ${short}`;
}
