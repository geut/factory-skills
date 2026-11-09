import path from 'node:path';

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

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

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

function candidatePath(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`;
}

// Every repository path that could hold a rule file for an agent in `place`.
export function ruleCandidates(place: RulesPlace): Array<string> {
  return ruleDirectories(place).flatMap((directory) =>
    CONTEXT_FILE_NAMES.map((name) => candidatePath(directory, name)),
  );
}

// The rule files among `paths`, repository-relative, in the order Pi reads
// them. Adding, removing, or editing any candidate changes the rules, since an
// added `AGENTS.override.md` shadows the `AGENTS.md` beside it.
export function changedRules(place: RulesPlace, paths: Iterable<string>): Array<string> {
  const changed = new Set(paths);
  return ruleCandidates(place).filter((candidate) => changed.has(candidate));
}

// The paths a unified diff touches, from its `diff --git a/<path> b/<path>`
// headers: both sides, so a rename counts for its source and its target.
export function diffPaths(diff: string): Array<string> {
  const paths = new Set<string>();
  for (const match of diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)) {
    for (const side of [match[1], match[2]]) {
      if (side !== undefined) {
        paths.add(side);
      }
    }
  }
  return [...paths];
}

// Where the reviewer's rules came from, as its system prompt and the review
// validation name it.
export function rulesSource(base: { branch: string | null; sha: string }): string {
  const short = base.sha.slice(0, 7);
  return base.branch === null ? `the base commit ${short}` : `${base.branch} at ${short}`;
}
