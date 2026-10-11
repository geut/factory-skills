import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { taskId, type PlanValidationReport, type PlannedTask } from '../domain.ts';
import { sha256 } from '../hash.ts';
import { stageEnabled } from '../stages/flow.ts';
import { acceptanceCriteria } from '../stages/qa/criteria.ts';
import { errorReport, failedReport, passedReport, type Validator } from './report.ts';

function blockedBy(markdown: string): Array<string> | null {
  const match = /^Blocked by:\s*(.+)$/m.exec(markdown);
  const value = match?.[1]?.trim();
  if (value === undefined) {
    return null;
  }
  if (value === 'none') {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function titleOf(markdown: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim() || fallback;
}

const taskFilePattern = /^(\d+)-task-.+\.md$/;

export const PLAN_VALIDATOR_VERSION = 'plan.v3';

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

  const tasks: Array<PlannedTask> = [];
  for (const filename of filenames) {
    const id = taskFilePattern.exec(filename)?.[1] ?? String(tasks.length + 1);
    let text = '';
    try {
      text = readFileSync(path.join(input.factoryDir, filename), 'utf8');
    } catch {
      text = '';
    }
    if (input.requireCriteria && acceptanceCriteria(text).length === 0) {
      failures.push(`${filename} lists no acceptance criteria; QA proves each one.`);
    }
    const deps = blockedBy(text) ?? [];
    tasks.push({
      blockedBy: deps.map((dep) => taskId(dep)),
      ordinal: Number(id),
      specHash: sha256(text),
      taskFile: filename,
      taskId: taskId(id),
      title: titleOf(text, `Task ${id}`),
    });
  }
  if (failures.length > 0) {
    return failedReport(
      PLAN_VALIDATOR_VERSION,
      failures.map((failure) => ({
        details: failure,
        kind: 'artifact',
        name: 'acceptance criteria',
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
