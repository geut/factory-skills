import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { factoryRootOf } from '../controller/keys.ts';
import { taskId, type PlanValidationReport, type PlannedTask } from '../domain.ts';
import { sha256 } from '../hash.ts';
import { stageEnabled } from '../stages/flow.ts';
import {
  CONTEXT_LINE_BUDGET,
  contextPathOf,
  createContextInstruction,
  inspectContext,
} from '../stages/plan/context.ts';
import { acceptanceCriteria } from '../stages/qa/criteria.ts';
import {
  errorReport,
  failedReport,
  passedReport,
  type ValidationCheck,
  type Validator,
} from './report.ts';
import { readTaskFile } from './task-file.ts';

function titleOf(markdown: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim() || fallback;
}

const taskFilePattern = /^(\d+)-task-.+\.md$/;

// Two files with one number would be one task to the store.
function duplicateFailures(filenames: Array<string>): Array<string> {
  const byNumber = new Map<number, Array<string>>();
  for (const name of filenames) {
    const number = Number(taskFilePattern.exec(name)?.[1]);
    byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
  }
  return [...byNumber.values()]
    .filter((names) => names.length > 1)
    .map((names) => `${names.join(' and ')} share a number; give each task file its own.`);
}

// The task with that number or filename, or null when none matches.
function resolveDependency(dep: number | string, filenames: Array<string>): string | null {
  const wanted = typeof dep === 'number' || /^\d+$/.test(dep) ? Number(dep) : null;
  for (const name of filenames) {
    const id = taskFilePattern.exec(name)?.[1] ?? '';
    if (wanted === null ? name === dep : Number(id) === wanted) {
      return id;
    }
  }
  return null;
}

// A cycle would leave every task in it waiting forever: one is reported.
function cycleFailure(tasks: Array<PlannedTask>): string | null {
  const blockers = new Map(tasks.map((task) => [task.taskId as string, task.blockedBy]));
  const state = new Map<string, 'visiting' | 'done'>();
  const trail: Array<string> = [];
  const visit = (id: string): Array<string> | null => {
    if (state.get(id) === 'done') {
      return null;
    }
    if (state.get(id) === 'visiting') {
      return [...trail.slice(trail.indexOf(id)), id];
    }
    state.set(id, 'visiting');
    trail.push(id);
    for (const dep of blockers.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle !== null) {
        return cycle;
      }
    }
    trail.pop();
    state.set(id, 'done');
    return null;
  };
  for (const task of tasks) {
    const cycle = visit(task.taskId);
    if (cycle !== null) {
      return `Tasks ${cycle.join(' → ')} block each other, so none of them can start.`;
    }
  }
  return null;
}

// The factory root's CONTEXT.md holds every required section. Its size is
// only a warning: trimming it is the person's call.
type ContextCheck = { check: ValidationCheck; failures: Array<string> };

function contextCheck(factoryRoot: string): ContextCheck {
  const file = contextPathOf(factoryRoot);
  const context = inspectContext(factoryRoot);
  const failures =
    context.kind === 'missing'
      ? [`CONTEXT.md is missing. ${createContextInstruction(factoryRoot)}`]
      : [
          ...context.missingSections.map(
            (section) =>
              `CONTEXT.md has no "## ${section}" section. Add it, saying "none known yet" if nothing is known, and leave the rest of the file as it is.`,
          ),
          ...context.emptySections.map(
            (section) =>
              `CONTEXT.md has an empty "## ${section}" section. Write what you learned, or "none known yet".`,
          ),
        ];
  const details =
    failures.length > 0
      ? failures.join('\n')
      : context.kind === 'read' && context.lines > CONTEXT_LINE_BUDGET
        ? `Warning: ${file} is ${context.lines} lines, over the ${CONTEXT_LINE_BUDGET}-line budget.`
        : file;
  return {
    check: {
      details,
      kind: 'artifact',
      name: 'CONTEXT.md',
      status: failures.length > 0 ? 'failed' : 'passed',
    },
    failures,
  };
}

export const PLAN_VALIDATOR_VERSION = 'plan.v5';

// A failed plan: one check per artifact failure, named by `nameOf`, then the
// CONTEXT.md check and its failures.
function planFailed(
  failures: Array<string>,
  nameOf: (failure: string) => string,
  context: ContextCheck,
): PlanValidationReport {
  return failedReport(
    PLAN_VALIDATOR_VERSION,
    [
      ...failures.map((failure): ValidationCheck => ({
        details: failure,
        kind: 'artifact',
        name: nameOf(failure),
        status: 'failed',
      })),
      context.check,
    ],
    [...failures, ...context.failures],
    null,
  );
}

// `requireCriteria`: QA is enabled, so every task needs acceptance criteria.
function inspectPlanDir(input: {
  factoryDir: string;
  requireCriteria: boolean;
}): PlanValidationReport {
  const failures: Array<string> = [];
  const planFile = path.join(input.factoryDir, 'plan.md');
  let filenames: Array<string>;
  try {
    filenames = readdirSync(input.factoryDir)
      .filter((name) => taskFilePattern.test(name))
      .sort();
  } catch {
    return errorReport(
      PLAN_VALIDATOR_VERSION,
      `Ticket directory ${input.factoryDir} cannot be read.`,
    );
  }
  let planText: string | null = null;
  try {
    planText = readFileSync(planFile, 'utf8');
  } catch {
    planText = null;
  }
  if (planText === null || planText.trim().length === 0) {
    failures.push('plan.md is missing.');
  }
  if (filenames.length === 0) {
    failures.push('At least one task file is required.');
  }
  const context = contextCheck(factoryRootOf(input.factoryDir));
  if (failures.length > 0) {
    return planFailed(failures, (failure) => failure, context);
  }

  failures.push(...duplicateFailures(filenames));
  const tasks: Array<PlannedTask> = [];
  for (const filename of filenames) {
    const id = taskFilePattern.exec(filename)?.[1] ?? String(tasks.length + 1);
    let text = '';
    try {
      text = readFileSync(path.join(input.factoryDir, filename), 'utf8');
    } catch {
      text = '';
    }
    const parsed = readTaskFile(filename, text);
    if (parsed.kind === 'failed') {
      failures.push(...parsed.failures);
      continue;
    }
    const { blocked_by, qa } = parsed.frontmatter;
    if (input.requireCriteria && qa === 'e2e' && acceptanceCriteria(parsed.body).length === 0) {
      failures.push(`${filename} lists no acceptance criteria; QA proves each one.`);
    }
    const deps = new Set<string>();
    for (const dep of blocked_by) {
      const resolved = resolveDependency(dep, filenames);
      if (resolved === null) {
        failures.push(
          `${filename} is blocked by ${dep}, which matches no task file number (${filenames.map((name) => taskFilePattern.exec(name)?.[1]).join(', ')}).`,
        );
      } else if (resolved === id) {
        failures.push(`${filename} is blocked by itself.`);
      } else {
        deps.add(resolved);
      }
    }
    tasks.push({
      blockedBy: [...deps].map((dep) => taskId(dep)),
      ordinal: Number(id),
      skips: qa === 'none' ? ['qa'] : [],
      specHash: sha256(text),
      taskFile: filename,
      taskId: taskId(id),
      title: titleOf(parsed.body, `Task ${id}`),
    });
  }
  const cycle = cycleFailure(tasks);
  if (cycle !== null) {
    failures.push(cycle);
  }
  if (failures.length > 0 || context.failures.length > 0) {
    return planFailed(failures, () => 'task files', context);
  }
  return passedReport(
    PLAN_VALIDATOR_VERSION,
    [
      { details: planFile, kind: 'artifact', name: 'plan.md', status: 'passed' },
      { details: String(tasks.length), kind: 'schema', name: 'task graph', status: 'passed' },
      context.check,
    ],
    { planPath: planFile, tasks },
  );
}

export const planValidator: Validator<'plan'> = {
  validate: ({ run, snapshot }) => {
    if (run.resultJson === null || run.resultHash === null) {
      return Promise.reject(new Error('validate action is missing a plan result'));
    }
    return Promise.resolve(
      inspectPlanDir({
        factoryDir: snapshot.execution.factoryDir,
        requireCriteria: stageEnabled(snapshot.execution.policy, 'qa'),
      }),
    );
  },
  version: PLAN_VALIDATOR_VERSION,
};
