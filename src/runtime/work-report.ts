import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

// A work agent's report travels as subagent_done's arguments, not as reply
// text: a model can write its reply where the controller never reads it (a
// thinking block), but a tool call's arguments arrive as sent. The child
// handshake checks a report before it ends the run, and the runtime reads
// the accepted call back from the session file and renders the work
// template from it.
//
// This file ships beside the child handshake, which Pi loads on its own, so
// it imports nothing but Node.

export const WORK_REPORT = 'work';

// Bounds that keep the selection well under the size an environment allows.
// Work validation reads a selection from reply text with the same ones.
export const MAX_TESTS = 100;
export const MAX_REASON = 300;

// What the handshake sends an agent that ends its turn without calling
// subagent_done: a run that never calls it has no report either.
export const REPORT_NUDGE =
  'Not finished: the controller reads only the arguments of subagent_done. Call subagent_done now with your report as its arguments.';

export type SelectedTest = { path: string; reason: string };

export type WorkReport = {
  blocker: string | null;
  e2e: { note: string | null; result: 'failed' | 'not_feasible' | 'passed' | 'qa' } | null;
  evidence: Array<string>;
  feedbackResponses: Array<{ disposition: 'addressed' | 'declined'; id: string; note: string }>;
  planChanged: boolean;
  reviewResponses: Array<{ id: string; response: string }>;
  selection: { mode: 'default'; reason: string } | { mode: 'focused'; tests: Array<SelectedTest> };
  status: 'blocked' | 'ready_for_review';
  summary: string;
  tests: Array<{ command: string; note: string | null; result: 'failed' | 'not_run' | 'passed' }>;
};

const text = (description: string) => ({ description, type: 'string' });

// subagent_done's parameters in a work run, as Pi shows them to the model
// and checks a call against them.
export const WORK_REPORT_PARAMETERS = {
  additionalProperties: false,
  properties: {
    blocker: text('Required when status is blocked: what stops the task.'),
    e2e: {
      additionalProperties: false,
      properties: {
        note: text('Evidence or the human path.'),
        result: {
          description: '`qa` when QA runs for the task and owns its end-to-end tests.',
          enum: ['passed', 'failed', 'not_feasible', 'qa'],
          type: 'string',
        },
      },
      required: ['result'],
      type: 'object',
    },
    evidence: {
      description: 'Screenshot or transcript paths that help a reviewer.',
      items: { type: 'string' },
      type: 'array',
    },
    feedback_responses: {
      description:
        'In a feedback round, one entry per item of the task file: addressed with what changed, or declined with why.',
      items: {
        additionalProperties: false,
        properties: {
          disposition: { enum: ['addressed', 'declined'], type: 'string' },
          id: text('The item, such as F1.'),
          note: text('What changed, or why it is declined.'),
        },
        required: ['id', 'disposition', 'note'],
        type: 'object',
      },
      type: 'array',
    },
    plan_changed: { description: 'Whether you changed plan.md.', type: 'boolean' },
    review_responses: {
      description: 'In a later round, one entry per finding you were asked to resolve.',
      items: {
        additionalProperties: false,
        properties: {
          id: text('The finding, such as R1-01.'),
          response: text('What you did, such as `fixed — tests/filter.test.ts:88`.'),
        },
        required: ['id', 'response'],
        type: 'object',
      },
      type: 'array',
    },
    status: { enum: ['ready_for_review', 'blocked'], type: 'string' },
    summary: text('One sentence for the observable result.'),
    tests: {
      description: 'What you ran.',
      items: {
        additionalProperties: false,
        properties: {
          command: text('Such as `npm test`.'),
          note: text('Such as `22 files / 109 tests`.'),
          result: { enum: ['passed', 'failed', 'not_run'], type: 'string' },
        },
        required: ['command', 'result'],
        type: 'object',
      },
      type: 'array',
    },
    validation_selection: {
      additionalProperties: false,
      description:
        'The tests work validation passes to the validation commands. `focused` lists the regression tests you found from your own diff; `default` lets the validator use its default behavior, with why.',
      properties: {
        mode: { enum: ['focused', 'default'], type: 'string' },
        reason: text('With `default`: why no focused tests.'),
        tests: {
          description: 'With `focused`: test files, relative to the repository root.',
          items: {
            additionalProperties: false,
            properties: {
              path: text('A test file, relative to the repository root.'),
              reason: text('Why it covers this change, in one short sentence.'),
            },
            required: ['path', 'reason'],
            type: 'object',
          },
          type: 'array',
        },
      },
      required: ['mode'],
      type: 'object',
    },
  },
  required: ['status', 'summary', 'validation_selection'],
  type: 'object',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function oneOf<T extends string>(value: unknown, values: ReadonlyArray<T>): T | null {
  return values.find((item) => item === value) ?? null;
}

// Each entry of an array field, as `read` makes it; null when the field is
// not an array or one entry is malformed. A missing field is empty.
function entries<T>(value: unknown, read: (entry: unknown) => T | null): Array<T> | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const items: Array<T> = [];
  for (const entry of value) {
    const item = read(entry);
    if (item === null) {
      return null;
    }
    items.push(item);
  }
  return items;
}

function selectionOf(value: unknown): WorkReport['selection'] | null {
  if (!isRecord(value)) {
    return null;
  }
  const mode = oneOf(value['mode'], ['focused', 'default'] as const);
  if (mode === 'default') {
    const tests = value['tests'];
    if (Array.isArray(tests) && tests.length > 0) {
      return null;
    }
    const reason = stringField(value, 'reason');
    return reason === null ? null : { mode, reason };
  }
  if (mode === 'focused') {
    const tests = entries(value['tests'], (entry) => {
      if (!isRecord(entry)) {
        return null;
      }
      const file = stringField(entry, 'path');
      const reason = stringField(entry, 'reason');
      return file === null || reason === null ? null : { path: file, reason };
    });
    return tests === null || tests.length === 0 ? null : { mode, tests };
  }
  return null;
}

// A report from a subagent_done call's arguments, or null when they do not
// make one: the call of a stage without a report, or one Pi or the handshake
// would have refused.
export function readWorkReport(value: unknown): WorkReport | null {
  if (!isRecord(value)) {
    return null;
  }
  const status = oneOf(value['status'], ['ready_for_review', 'blocked'] as const);
  const summary = stringField(value, 'summary');
  const selection = selectionOf(value['validation_selection']);
  const tests = entries(value['tests'], (entry) => {
    if (!isRecord(entry)) {
      return null;
    }
    const command = stringField(entry, 'command');
    const result = oneOf(entry['result'], ['passed', 'failed', 'not_run'] as const);
    return command === null || result === null
      ? null
      : { command, note: stringField(entry, 'note'), result };
  });
  const reviewResponses = entries(value['review_responses'], (entry) => {
    if (!isRecord(entry)) {
      return null;
    }
    const id = stringField(entry, 'id');
    const response = stringField(entry, 'response');
    return id === null || response === null ? null : { id, response };
  });
  const feedbackResponses = entries(value['feedback_responses'], (entry) => {
    if (!isRecord(entry)) {
      return null;
    }
    const id = stringField(entry, 'id');
    const disposition = oneOf(entry['disposition'], ['addressed', 'declined'] as const);
    const note = typeof entry['note'] === 'string' ? entry['note'].trim() : null;
    return id === null || disposition === null || note === null
      ? null
      : { disposition, id: id.toUpperCase(), note };
  });
  const evidence = entries(value['evidence'], (entry) =>
    typeof entry === 'string' && entry.trim().length > 0 ? entry.trim() : null,
  );
  const e2eValue = value['e2e'];
  const e2eResult = isRecord(e2eValue)
    ? oneOf(e2eValue['result'], ['passed', 'failed', 'not_feasible', 'qa'] as const)
    : null;
  const planChanged = value['plan_changed'];
  if (
    status === null ||
    summary === null ||
    selection === null ||
    tests === null ||
    reviewResponses === null ||
    feedbackResponses === null ||
    evidence === null ||
    (e2eValue !== undefined && e2eValue !== null && e2eResult === null) ||
    (planChanged !== undefined && planChanged !== null && typeof planChanged !== 'boolean')
  ) {
    return null;
  }
  return {
    blocker: stringField(value, 'blocker'),
    e2e:
      e2eResult === null || !isRecord(e2eValue)
        ? null
        : { note: stringField(e2eValue, 'note'), result: e2eResult },
    evidence,
    feedbackResponses,
    planChanged: planChanged === true,
    reviewResponses,
    selection,
    status,
    summary,
    tests,
  };
}

// `file` normalized as a path relative to the repository root, or null when
// it leaves the repository.
export function repositoryPath(file: string): string | null {
  const normal = path.posix.normalize(file.replaceAll('\\', '/'));
  return path.posix.isAbsolute(normal) || normal === '..' || normal.startsWith('../')
    ? null
    : normal;
}

// Whether `file` is a file inside `root`, symlinks resolved.
export function fileInside(root: string, file: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(path.join(root, file));
    const relative = path.relative(realRoot, real);
    return (
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      statSync(real).isFile()
    );
  } catch {
    return false;
  }
}

function selectionProblems(selection: unknown, worktree: string): Array<string> {
  const read = selectionOf(selection);
  const mode = isRecord(selection) ? selection['mode'] : undefined;
  if (read === null) {
    return [
      mode === 'default'
        ? 'validation_selection: `default` needs a `reason` and no `tests`.'
        : mode === 'focused'
          ? 'validation_selection: `focused` needs `tests`, each with a `path` and a `reason`; use `default` with a `reason` to propose none.'
          : 'validation_selection: set `mode` to `focused` with `tests`, or `default` with a `reason`.',
    ];
  }
  if (read.mode === 'default') {
    return [];
  }
  const problems: Array<string> = [];
  if (read.tests.length > MAX_TESTS) {
    problems.push(
      `validation_selection.tests: ${read.tests.length} files; list at most ${MAX_TESTS}, the ones that cover this change.`,
    );
  }
  read.tests.forEach((test, index) => {
    const at = `validation_selection.tests[${index}]`;
    const normal = repositoryPath(test.path);
    if (normal === null) {
      problems.push(
        `${at}.path: ${test.path} is outside the repository; give it relative to the repository root.`,
      );
    } else if (!fileInside(worktree, normal)) {
      problems.push(`${at}.path: ${test.path} is not a file in this worktree.`);
    }
    if (test.reason.length > MAX_REASON) {
      problems.push(
        `${at}.reason: longer than ${MAX_REASON} characters; keep it to one short sentence.`,
      );
    }
  });
  return problems;
}

function feedbackProblems(
  responses: WorkReport['feedbackResponses'],
  expected: ReadonlyArray<string>,
): Array<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const response of responses) {
    if (!expected.includes(response.id)) {
      problems.push(
        expected.length === 0
          ? `feedback_responses: ${response.id} is not an item; this task is not a feedback round, so leave feedback_responses out.`
          : `feedback_responses: ${response.id} is not an item of this round (${expected.join(', ')}).`,
      );
    } else if (seen.has(response.id)) {
      problems.push(`feedback_responses: ${response.id} is answered twice; answer each item once.`);
    }
    seen.add(response.id);
    if (response.disposition === 'declined' && response.note.length === 0) {
      problems.push(`feedback_responses: ${response.id} is declined without a reason in its note.`);
    }
  }
  const missing = expected.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    problems.push(
      `feedback_responses: answer ${missing.join(', ')}, each addressed with what changed or declined with why.`,
    );
  }
  return problems;
}

// What is wrong with a subagent_done call's arguments as a work report,
// field by field; empty when the report is complete. `worktree` is where the
// selected tests must be, and `feedbackItems` the round's items, empty for a
// planned task.
export function workReportProblems(
  args: unknown,
  context: { feedbackItems: ReadonlyArray<string>; worktree: string },
): Array<string> {
  if (!isRecord(args)) {
    return ['The report is the arguments of subagent_done: status, summary, validation_selection.'];
  }
  const problems: Array<string> = [];
  if (oneOf(args['status'], ['ready_for_review', 'blocked'] as const) === null) {
    problems.push('status: `ready_for_review` or `blocked`.');
  }
  if (stringField(args, 'summary') === null) {
    problems.push('summary: one sentence for the observable result.');
  }
  if (args['status'] === 'blocked' && stringField(args, 'blocker') === null) {
    problems.push('blocker: a blocked report says what stops the task.');
  }
  problems.push(...selectionProblems(args['validation_selection'], context.worktree));
  const report = readWorkReport(args);
  if (report !== null) {
    problems.push(...feedbackProblems(report.feedbackResponses, context.feedbackItems));
  } else if (problems.length === 0) {
    problems.push(
      'A field has the wrong shape; check tests, e2e, review_responses, feedback_responses, plan_changed, and evidence against the tool parameters.',
    );
  }
  return problems;
}

// A field on one line, so no value can start a section of its own.
function line(value: string): string {
  return value.replaceAll(/\s*\n\s*/g, ' ').trim();
}

function withNote(head: string, note: string | null): string {
  return note === null || note.length === 0 ? head : `${head} — ${line(note)}`;
}

function list(items: Array<string>): string {
  return items.length === 0 ? 'none' : items.join('\n');
}

// The report as the work template (`factory.work.v3`), the reply the rest of
// the controller, review, and the pull request read.
export function renderWorkReport(report: WorkReport): string {
  const selection =
    report.selection.mode === 'default'
      ? `none (${line(report.selection.reason).replaceAll(/[()]/g, '')})`
      : report.selection.tests.map((test) => `- \`${test.path}\`: ${line(test.reason)}`).join('\n');
  const e2e =
    report.e2e === null
      ? 'not_reported'
      : [
          report.e2e.result,
          ...(report.e2e.note === null ? [] : [`Note: ${line(report.e2e.note)}`]),
        ].join('\n');
  const sections: Array<[string, string]> = [
    ['Status', report.status],
    ['Summary', line(report.summary)],
    [
      'Tests',
      list(
        report.tests.map((test) =>
          withNote(`- \`${line(test.command)}\`: ${test.result}`, test.note),
        ),
      ),
    ],
    ['Validation selection', selection],
    ['E2E', e2e],
    [
      'Review responses',
      list(report.reviewResponses.map((item) => `- ${line(item.id)}: ${line(item.response)}`)),
    ],
    [
      'Feedback responses',
      list(
        report.feedbackResponses.map((item) =>
          withNote(`- ${item.id}: ${item.disposition}`, item.note),
        ),
      ),
    ],
    ['Plan changed', String(report.planChanged)],
    ['Blocker', report.blocker === null ? 'none' : line(report.blocker)],
    ['Evidence', list(report.evidence.map((item) => `- ${line(item)}`))],
  ];
  return sections.map(([heading, body]) => `## ${heading}\n\n${body}`).join('\n\n');
}

const MISSING_HEADING = '## Report missing';

// What a work run that ended without a report replies: why, for work
// validation to stop on before any command runs, and for the ticket view.
// `refusal` is the last refused report's error, if any.
export function renderMissingReport(refusal: string | null): string {
  return [
    MISSING_HEADING,
    '',
    'The run ended without a report: subagent_done refused it, or the agent ended its turn without calling it.',
    ...(refusal === null ? [] : ['', 'The last refusal:', refusal]),
  ].join('\n');
}

// Why a work reply is no report, or null when it is one (or a reply from an
// older session, read from its text).
export function missingReport(output: string): string | null {
  return output.startsWith(`${MISSING_HEADING}\n`)
    ? output.slice(MISSING_HEADING.length).trim()
    : null;
}
