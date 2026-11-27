import type { FactorySnapshot, RunRecord } from '../domain.ts';
import {
  fileInside,
  MAX_REASON,
  MAX_TESTS,
  repositoryPath,
  selectionSection,
  type SelectedTest,
  type WorkReport,
} from '../runtime/work-report.ts';
import { runOutput } from '../stages/output.ts';

// The tests a worker proposes for validation: focused regression tests it
// found from its own diff. The controller passes them to the configured
// validation commands as JSON in an environment variable, keeps its argv,
// and leaves the project's validator to interpret the paths and pick the
// runner.

export const SELECTION_ENV = 'FACTORY_VALIDATION_SELECTION';
export const SELECTION_HEADING = 'Validation selection';
// The work check that shows what the commands got.
export const SELECTION_CHECK = 'validation selection';

export type { SelectedTest };

export type ValidationSelection = { tests: Array<SelectedTest>; version: 1 };

export type ParsedSelection =
  // The reply has no section.
  | { kind: 'absent' }
  | { kind: 'listed'; tests: Array<SelectedTest> }
  | { kind: 'invalid'; problems: Array<string> };

// One entry: `` - `tests/test_filter.py`: why it covers this change ``.
const ENTRY = /^- `([^`]+)`:\s*(.+)$/;

export const SELECTION_FORMAT =
  'Under ## Validation selection, write one line per test file, `` - `path/to/test_file`: why it covers this change ``, with the path relative to the repository root.';

// What every selection problem ends with: the section is optional, and a
// reply that leaves it out keeps the round's selection, so it is written
// again.
export const SELECTION_FIX =
  'The selection is optional: write the section again with the lines fixed, or with `none` alone, so the validator uses its default behavior.';

// `none`, as people write it: `none`, `- none`, `` `none` ``, `None.`, or
// `none (no focused tests)`.
function saysNone(line: string): boolean {
  const bare = line
    .replace(/^[-*]\s+/, '')
    .replace(/\s*\(.*\)\s*$/, '')
    .replaceAll('`', '')
    .replace(/\.$/, '')
    .trim();
  return bare.toLowerCase() === 'none';
}

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
  if (lines.length === 0 || (lines.length === 1 && saysNone(lines[0] ?? ''))) {
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
    const normal = repositoryPath(file);
    if (normal === null) {
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

// A selection given as a report's arguments, as work validation reads it at
// submission: rendered into the report's section and parsed back, so a
// validation asked for with it gets the very tests the submission would.
export function submittedSelection(selection: WorkReport['selection']): ParsedSelection {
  return parseSelection(`## ${SELECTION_HEADING}\n${selectionSection(selection)}\n`);
}

// What `tests` names that the worktree does not have as a file, by the rule
// the handshake checks a report's selection with.
export function missingTests(tests: Array<SelectedTest>, worktree: string): Array<string> {
  return tests
    .filter((test) => !fileInside(worktree, test.path))
    .map(
      (test) =>
        `Validation selection: ${test.path} is not a file in the worktree; list test files that exist.`,
    );
}

// The runs that start a round of work on a task: its first run, and each
// return from a later stage. A correction, an answer to a question, a manual
// continue, or a retry carries on the round.
const ROUND_STARTS: ReadonlySet<RunRecord['purpose']> = new Set(['initial', 'return_to_work']);

// The task's selection in its current round, as of `upTo` when given: from
// the round's latest finished reply that wrote the section. A correction
// that leaves the section out keeps the round's; `none` clears it. A new
// round starts with none, so an earlier round's paths never come back; the
// reviewer reads the same round's replies.
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
  const at = upTo === null ? -1 : snapshot.runs.indexOf(upTo);
  const runs = (at === -1 ? snapshot.runs : snapshot.runs.slice(0, at + 1)).filter((run) =>
    sessions.has(run.sessionId),
  );
  const round = runs.slice(
    Math.max(
      0,
      runs.findLastIndex((run) => ROUND_STARTS.has(run.purpose)),
    ),
  );
  for (const run of round.toReversed()) {
    if (run.terminalKind !== 'subagent_done') {
      continue;
    }
    const parsed = parseSelection(runOutput(run));
    if (parsed.kind !== 'absent') {
      return parsed;
    }
  }
  return { kind: 'absent' };
}
