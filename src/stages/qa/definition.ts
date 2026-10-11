import type { WorkCommand } from '../../config.ts';
import type { Policy } from '../../domain.ts';
import type { ValidationReport } from '../../validation/report.ts';
import { defineStage, type LimitSpec, type SettingsResult } from '../definition.ts';
import { runOutput } from '../output.ts';
import { childInstructions, childToolList } from '../prompt.ts';
import type { Criterion } from './criteria.ts';

// QA failed either because its own output is incomplete (a correction) or
// because the product does not meet a criterion (a return to work).
export type QaValidationReport = ValidationReport<
  { diff: string; gaps: number; tested: number },
  { reason: 'incomplete' | 'product' }
>;

// What QA's input preparation read from the task file and set up.
export type QaPrepared = { criteria: Array<Criterion>; dir: string };

export type QaInput = {
  commands: Array<WorkCommand>;
  criteria: Array<Criterion>;
  dir: string;
  displayRef: string;
  planPath: string;
  round: number;
  taskFile: string;
  taskId: string;
  title: string;
  worktree: string;
};

export type QaSettings = { commands: Array<WorkCommand>; enabled: boolean };

const DEFAULT_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCommand(value: unknown): WorkCommand | null {
  if (!isRecord(value)) {
    return null;
  }
  const { argv, name, timeoutMs } = value;
  if (
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((arg) => typeof arg !== 'string' || arg.length === 0) ||
    (timeoutMs !== undefined &&
      (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0))
  ) {
    return null;
  }
  return { argv, name, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS };
}

// FACTORY.json `stages.qa`: `{ "enabled": true, "commands": [{ name, argv, timeoutMs? }] }`.
// QA is off unless enabled, and it needs at least one command to run.
export function readQaSettings(raw: unknown): SettingsResult {
  if (raw === undefined) {
    return { kind: 'ok', settings: { commands: [], enabled: false } };
  }
  const invalid = {
    kind: 'error' as const,
    message:
      'FACTORY.json stages.qa must be { "enabled": boolean, "commands": [{ "name", "argv", "timeoutMs"? }] }.',
  };
  if (!isRecord(raw) || (raw['enabled'] !== undefined && typeof raw['enabled'] !== 'boolean')) {
    return invalid;
  }
  const listed = raw['commands'] ?? [];
  if (!Array.isArray(listed)) {
    return invalid;
  }
  const commands = listed.map(readCommand);
  if (commands.some((command) => command === null)) {
    return invalid;
  }
  const enabled = raw['enabled'] === true;
  if (enabled && commands.length === 0) {
    return { kind: 'error', message: 'FACTORY.json stages.qa needs at least one command.' };
  }
  return {
    kind: 'ok',
    settings: { commands: commands.filter((command) => command !== null), enabled },
  };
}

// The QA settings snapshotted into an execution's policy.
export function qaSettings(policy: Policy): QaSettings {
  const read = readQaSettings(policy.stages['qa']);
  if (read.kind === 'error' || !Array.isArray(read.settings['commands'])) {
    return { commands: [], enabled: false };
  }
  return {
    commands: read.settings['commands'] as Array<WorkCommand>,
    enabled: read.settings.enabled,
  };
}

// The FACTORY.json limits this stage reads.
export const qaLimits = {
  qaCorrections: { default: 2, min: 0 },
  qaRounds: { default: 3, min: 1 },
} as const satisfies Record<string, LimitSpec>;

const skill = 'factory-qa';
const contract = 'factory.qa.v1';
const tools = ['read', 'bash', 'grep', 'find', 'ls', 'edit', 'write'];

export const qa = defineStage<QaInput, 'qa', QaPrepared>({
  conclude: ({ snapshot, task }, run, report) => {
    const round = run.semanticRound;
    if (report.status === 'passed') {
      // Review reads what the worker said, then what QA proved.
      const work = snapshot.sessions.find(
        (item) => item.stage === 'work' && item.taskId === task?.taskId,
      );
      const worker = [...snapshot.runs]
        .reverse()
        .find((item) => item.sessionId === work?.id && item.terminalKind === 'subagent_done');
      const output = [
        worker === undefined ? '' : runOutput(worker),
        '',
        'QA summary:',
        runOutput(run),
      ].join('\n');
      return {
        handoff: { checks: report.checks, diff: report.detail.diff, output: output.trim() },
        kind: 'accept',
        summary: {
          counts: { gaps: report.detail.gaps, tested: report.detail.tested },
          label: 'passed',
          round,
        },
      };
    }
    if (report.detail.reason === 'incomplete') {
      return { failures: report.failures, kind: 'correct' };
    }
    const summary = { counts: { failing: report.failures.length }, label: 'failed', round };
    const limit = snapshot.execution.policy.limits.qaRounds;
    if (round >= limit) {
      return {
        code: 'qa_round_limit',
        failures: report.failures,
        kind: 'pause',
        message: `QA round limit reached for task ${task?.taskId ?? '?'}.`,
        question: [
          `QA round ${round} of ${limit} for task ${task?.taskId ?? '?'} still fails acceptance tests:`,
          ...report.failures.map((failure) => `- ${failure}`),
          'Reply to tell the QA agent how to settle them.',
        ].join('\n'),
        reply: true,
        summary,
      };
    }
    return { kind: 'return_to_work', problems: report.failures, summary };
  },
  contract,
  corrections: {
    limit: 'qaCorrections',
    limitNotice: 'QA output is still incomplete after the correction limit:',
    per: 'round',
  },
  emoji: '🧪',
  input: ({ snapshot, task }, { prepared, round }) => {
    const execution = snapshot.execution;
    if (task === null || execution.worktreePath === null) {
      throw new Error('QA runs for a task in a ready worktree.');
    }
    return {
      commands: qaSettings(execution.policy).commands,
      criteria: prepared.criteria,
      dir: prepared.dir,
      displayRef: snapshot.ticket.displayRef,
      planPath: execution.planPath ?? '',
      round,
      taskFile: `${execution.factoryDir}/${task.taskFile}`,
      taskId: task.taskId,
      title: task.title,
      worktree: execution.worktreePath,
    };
  },
  label: 'QA',
  // QA writes tests, so it runs on the work model.
  model: 'work',
  name: 'qa',
  optional: true,
  preparesInput: true,
  prompts: {
    correction: (failures) =>
      [
        childInstructions(skill, contract),
        '',
        `QA validation found your output incomplete. Fix these exact problems and return the complete ${contract} template again:`,
        ...failures.map((failure) => `- ${failure}`),
      ].join('\n'),
    initial: (input) =>
      [
        childInstructions(skill, contract),
        '',
        `Ticket: ${input.displayRef}`,
        `Task: ${input.taskId} ${input.title}`,
        `Task file: ${input.taskFile}`,
        `Plan: ${input.planPath}`,
        `QA round: ${input.round}`,
        `Tools: ${childToolList(tools)}`,
        `Worktree: ${input.worktree}`,
        `QA directory: ${input.dir}`,
        '',
        'Acceptance criteria:',
        ...input.criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}`),
        '',
        'Write one observable end-to-end test per criterion in the worktree, beside the project tests.',
        `Write ${input.dir}/test-plan.md with a | AC | Test | Screenshot | row per tested criterion; screenshot paths are relative to the QA directory, under screenshots/.`,
        `Write ${input.dir}/ledger.md with a "- ACn: reason" line for every criterion the tests do not prove, and for any other gap.`,
        'The controller runs these commands in the worktree and fails QA when one fails:',
        ...input.commands.map((command) => `- ${command.name}: ${command.argv.join(' ')}`),
        'Do not change product code. Leave the work uncommitted.',
      ].join('\n'),
  },
  rounds: true,
  scope: 'task',
  settings: readQaSettings,
  skill,
  thinking: 'medium',
  tools,
});
