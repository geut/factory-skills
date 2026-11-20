import { statSync } from 'node:fs';
import path from 'node:path';
import type { FactorySnapshot, RunRecord } from '../domain.ts';
import { runOutput } from '../stages/output.ts';

// The tests a worker proposes for validation: focused regression tests it
// found from its own diff. The controller passes them to the configured
// validation commands as JSON in an environment variable, keeps its argv,
// and leaves the project's validator to interpret the paths and pick the
// runner.

export const SELECTION_ENV = 'FACTORY_VALIDATION_SELECTION';
export const SELECTION_HEADING = 'Validation selection';

// Bounds that keep the variable well under the size an environment allows.
const MAX_TESTS = 100;
const MAX_REASON = 300;

export type SelectedTest = { path: string; reason: string };

export type ValidationSelection = { tests: Array<SelectedTest>; version: 1 };

export type ParsedSelection =
  // The reply has no section.
  | { kind: 'absent' }
  | { kind: 'listed'; tests: Array<SelectedTest> }
  | { kind: 'invalid'; problems: Array<string> };

// One entry: `` - `tests/test_filter.py`: why it covers this change ``.
const ENTRY = /^- `([^`]+)`:\s*(.+)$/;

export const SELECTION_FORMAT =
  'Under ## Validation selection, write one line per test file, `` - `path/to/test_file`: why it covers this change ``, with the path relative to the repository root, or `none`.';

// The section's lines, or null when the reply has none. The section ends at
// the next heading of its level or higher.
function sectionLines(output: string): Array<string> | null {
  const lines = output.split('\n');
  const start = lines.findIndex((line) =>
    new RegExp(`^##\\s+${SELECTION_HEADING}\\s*$`, 'i').test(line.trim()),
  );
  if (start === -1) {
    return null;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line.trim()));
  return (end === -1 ? rest : rest.slice(0, end))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// The selection a work reply lists, checked for shape: entries in the
// format, repository-relative paths, a reason each.
export function parseSelection(output: string): ParsedSelection {
  const lines = sectionLines(output);
  if (lines === null) {
    return { kind: 'absent' };
  }
  if (lines.length === 0 || (lines.length === 1 && lines[0]?.toLowerCase() === 'none')) {
    return { kind: 'listed', tests: [] };
  }
  const problems: Array<string> = [];
  const tests: Array<SelectedTest> = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const entry = ENTRY.exec(line);
    const file = entry?.[1]?.trim() ?? '';
    const reason = entry?.[2]?.trim() ?? '';
    if (entry === null || file.length === 0 || reason.length === 0) {
      problems.push(`Validation selection: "${line}" is not an entry. ${SELECTION_FORMAT}`);
      continue;
    }
    const normal = path.posix.normalize(file.replaceAll('\\', '/'));
    if (path.posix.isAbsolute(normal) || normal === '..' || normal.startsWith('../')) {
      problems.push(
        `Validation selection: ${file} is outside the repository; give the path relative to its root.`,
      );
      continue;
    }
    if (reason.length > MAX_REASON) {
      problems.push(
        `Validation selection: the reason for ${file} is longer than ${MAX_REASON} characters; keep it to one short sentence.`,
      );
      continue;
    }
    if (!seen.has(normal)) {
      seen.add(normal);
      tests.push({ path: normal, reason });
    }
  }
  if (tests.length > MAX_TESTS) {
    problems.push(
      `Validation selection lists ${tests.length} test files; list at most ${MAX_TESTS}, the ones that cover this change.`,
    );
  }
  return problems.length === 0 ? { kind: 'listed', tests } : { kind: 'invalid', problems };
}

// What `tests` names that the worktree does not have as a file.
export function missingTests(tests: Array<SelectedTest>, worktree: string): Array<string> {
  return tests
    .filter(
      (test) =>
        statSync(path.join(worktree, test.path), { throwIfNoEntry: false })?.isFile() !== true,
    )
    .map(
      (test) =>
        `Validation selection: ${test.path} is not a file in the worktree; list test files that exist.`,
    );
}

// The task's selection: from the latest finished work run that wrote the
// section, up to `upTo` when given. A correction that leaves the section out
// keeps the one before; `none` clears it. Older replies with no section
// select nothing.
export function taskSelection(
  snapshot: FactorySnapshot,
  taskId: string,
  upTo: RunRecord | null = null,
): ParsedSelection {
  const sessions = new Set(
    snapshot.sessions
      .filter((session) => session.stage === 'work' && session.taskId === taskId)
      .map((session) => session.id),
  );
  const last = upTo === null ? snapshot.runs.length : snapshot.runs.indexOf(upTo) + 1;
  const runs = snapshot.runs
    .slice(0, last <= 0 ? snapshot.runs.length : last)
    .filter((run) => sessions.has(run.sessionId) && run.terminalKind === 'subagent_done');
  for (const run of runs.toReversed()) {
    const parsed = parseSelection(runOutput(run));
    if (parsed.kind !== 'absent') {
      return parsed;
    }
  }
  return { kind: 'absent' };
}

// A fresh environment for one command: the server's own, with the selection
// when there is one, so parallel tickets never see each other's.
export function selectionEnv(tests: Array<SelectedTest> | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[SELECTION_ENV];
  if (tests !== null && tests.length > 0) {
    env[SELECTION_ENV] = JSON.stringify({ tests, version: 1 } satisfies ValidationSelection);
  }
  return env;
}
