import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { taskId, taskTypes, type PlanValidationReport, type PlannedTask } from '../domain.ts';
import { sha256 } from '../hash.ts';
import { stageEnabled } from '../stages/flow.ts';
import { acceptanceCriteria } from '../stages/qa/criteria.ts';
import { errorReport, failedReport, passedReport, type Validator } from './report.ts';

// A task file starts with YAML frontmatter holding what the planner decides
// about the task. Status and stage are the controller's and live in its store.
const frontmatterPattern = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

// A dependency names another task file by its number (1, 01, "01") or its
// filename. YAML reads an unquoted 01 as the number 1, so numbers compare by
// value.
const dependency = z.union([z.number().int().nonnegative(), z.string().trim().min(1)]);

const frontmatterSchema = z.strictObject({
  blocked_by: z.array(dependency),
  qa: z.enum(['e2e', 'none']),
  type: z.enum(taskTypes),
});

type Frontmatter = z.infer<typeof frontmatterSchema>;

const fields = 'type, qa and blocked_by';

function issueText(issue: z.core.$ZodIssue, data: object): string {
  const key = issue.path.join('.');
  if (issue.code === 'unrecognized_keys') {
    return `has ${issue.keys.join(', ')} in its frontmatter, which holds only ${fields}`;
  }
  if (issue.path.length === 1 && !(key in data)) {
    return `has no ${key} in its frontmatter`;
  }
  return `has an invalid ${key || 'frontmatter'}: ${issue.message}`;
}

function readFrontmatter(
  filename: string,
  text: string,
):
  | { body: string; frontmatter: Frontmatter; kind: 'parsed' }
  | { failures: Array<string>; kind: 'failed' } {
  const match = frontmatterPattern.exec(text);
  if (match === null) {
    return {
      failures: [`${filename} has no frontmatter; start it with ---, then ${fields}, then ---.`],
      kind: 'failed',
    };
  }
  let data: unknown;
  try {
    data = parseYaml(match[1] ?? '');
  } catch (error: unknown) {
    const message = (error instanceof Error ? error.message : String(error))
      .split('\n')[0]
      ?.replace(/:$/, '');
    return {
      failures: [`${filename} has frontmatter that is not YAML: ${message}.`],
      kind: 'failed',
    };
  }
  const fieldsFound = typeof data === 'object' && data !== null ? data : {};
  const result = frontmatterSchema.safeParse(fieldsFound);
  if (!result.success) {
    return {
      failures: result.error.issues.map((issue) => `${filename} ${issueText(issue, fieldsFound)}.`),
      kind: 'failed',
    };
  }
  return { body: text.slice(match[0].length), frontmatter: result.data, kind: 'parsed' };
}

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

export const PLAN_VALIDATOR_VERSION = 'plan.v4';

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
  if (failures.length > 0) {
    return failedReport(
      PLAN_VALIDATOR_VERSION,
      failures.map((failure) => ({
        details: failure,
        kind: 'artifact',
        name: failure,
        status: 'failed',
      })),
      failures,
      null,
    );
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
    const parsed = readFrontmatter(filename, text);
    if (parsed.kind === 'failed') {
      failures.push(...parsed.failures);
      continue;
    }
    const { blocked_by, qa, type } = parsed.frontmatter;
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
      taskType: type,
      title: titleOf(parsed.body, `Task ${id}`),
    });
  }
  const cycle = cycleFailure(tasks);
  if (cycle !== null) {
    failures.push(cycle);
  }
  if (failures.length > 0) {
    return failedReport(
      PLAN_VALIDATOR_VERSION,
      failures.map((failure) => ({
        details: failure,
        kind: 'artifact',
        name: 'task files',
        status: 'failed',
      })),
      failures,
      null,
    );
  }
  return passedReport(
    PLAN_VALIDATOR_VERSION,
    [
      { details: planFile, kind: 'artifact', name: 'plan.md', status: 'passed' },
      { details: String(tasks.length), kind: 'schema', name: 'task graph', status: 'passed' },
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
