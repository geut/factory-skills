import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReviewValidationReport } from '../domain.ts';
import { sha256 } from '../hash.ts';
import { stageTools } from '../stages/index.ts';
import { runOutput } from '../stages/output.ts';
import { taskCriteria } from '../stages/qa/criteria.ts';
import {
  earlierFindings,
  parseReview,
  REVIEW_CONTRACT_V4,
  type ReviewContext,
} from '../stages/review/parse.ts';
import {
  errorReport,
  failedReport,
  failuresOf,
  passedReport,
  type ValidationCheck,
  type Validator,
} from './report.ts';
import { collectWorkDiff } from './work.ts';

const mutatingTools = new Set(['bash', 'edit', 'write']);

export const REVIEW_VALIDATOR_VERSION = 'review.v1';

function reviewChecks(input: {
  contract: string;
  currentDiffHash: string;
  resultError: string | null;
  resultStatus: 'pending' | 'valid' | 'invalid';
  reviewedDiffHash: string | null;
  reviewModel: string;
  tools: string;
  // What checking the Verification lines against the task and worktree found.
  verificationFailures: Array<string>;
  workModel: string;
}): ReviewValidationReport {
  const mutating = input.tools
    .split(',')
    .map((tool) => tool.trim())
    .filter((tool) => mutatingTools.has(tool));
  const isolation: Array<ValidationCheck> = [
    {
      details:
        input.reviewModel === input.workModel
          ? `reviewer and worker both use ${input.workModel}`
          : `${input.reviewModel} reviewed work from ${input.workModel}`,
      kind: 'policy',
      name: 'reviewer model',
      status: input.reviewModel === input.workModel ? 'failed' : 'passed',
    },
    {
      details: mutating.length > 0 ? `mutating tools: ${mutating.join(', ')}` : input.tools,
      kind: 'policy',
      name: 'read-only tools',
      status: mutating.length > 0 ? 'failed' : 'passed',
    },
  ];
  const fresh = input.reviewedDiffHash === null || input.reviewedDiffHash === input.currentDiffHash;
  const freshness: Array<ValidationCheck> =
    input.reviewedDiffHash === null
      ? []
      : [
          {
            details: fresh
              ? 'the worktree diff matches the reviewed diff'
              : 'the worktree diff changed after it was sent to the reviewer',
            kind: 'diff',
            name: 'reviewed diff',
            status: fresh ? 'passed' : 'failed',
          },
        ];
  const schemaFailures =
    input.resultStatus === 'valid'
      ? input.verificationFailures
      : (input.resultError ?? 'The review result was not parsed.')
          .split('\n')
          .filter((line) => line.length > 0);
  const schema: ValidationCheck = {
    details: schemaFailures.length === 0 ? input.contract : schemaFailures.join('\n'),
    kind: 'schema',
    name: 'review result',
    status: schemaFailures.length === 0 ? 'passed' : 'failed',
  };
  const checks = [schema, ...isolation, ...freshness];
  const version = REVIEW_VALIDATOR_VERSION;
  if (failuresOf(isolation).length > 0) {
    return failedReport(version, checks, failuresOf(isolation), { reason: 'unsafe' });
  }
  if (!fresh) {
    return failedReport(version, checks, failuresOf(freshness), { reason: 'stale' });
  }
  if (schemaFailures.length > 0) {
    return failedReport(version, checks, schemaFailures, { reason: 'malformed' });
  }
  return passedReport(version, checks, null);
}

// The line count of a file in the worktree, or null when it is missing or
// outside it.
function worktreeLines(cwd: string): ReviewContext['lineCount'] {
  return (file) => {
    const resolved = path.resolve(cwd, file);
    if (!resolved.startsWith(`${path.resolve(cwd)}${path.sep}`)) {
      return null;
    }
    try {
      const text = readFileSync(resolved, 'utf8');
      return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } catch {
      return null;
    }
  };
}

function validateReview(input: {
  context: ReviewContext;
  contract: string;
  cwd: string;
  output: string;
  resultError: string | null;
  resultStatus: 'pending' | 'valid' | 'invalid';
  reviewedDiffHash: string | null;
  reviewModel: string;
  round: number;
  tools: string;
  workModel: string;
}): ReviewValidationReport {
  const collected = collectWorkDiff(input.cwd);
  if ('message' in collected) {
    return errorReport(REVIEW_VALIDATOR_VERSION, collected.message);
  }
  // The run's parse checked the template; only a v5 review has lines to check
  // against the task and the worktree.
  const parsed =
    input.resultStatus === 'valid' && input.contract !== REVIEW_CONTRACT_V4
      ? parseReview(input.output, input.round, input.contract, input.context)
      : null;
  return reviewChecks({
    ...input,
    currentDiffHash: sha256(collected.diff),
    verificationFailures: parsed?.kind === 'invalid' ? parsed.failures : [],
  });
}

export const reviewValidator: Validator<'review'> = {
  validate: ({ run, session, snapshot }) => {
    const worktree = snapshot.execution.worktreePath;
    if (worktree === null) {
      return Promise.resolve(errorReport(REVIEW_VALIDATOR_VERSION, 'Worktree is missing.'));
    }
    const workSession =
      snapshot.sessions.find((item) => item.stage === 'work' && item.taskId === session.taskId) ??
      null;
    const task = snapshot.tasks.find((item) => item.taskId === session.taskId) ?? null;
    return Promise.resolve(
      validateReview({
        context: {
          criteria:
            task === null
              ? []
              : taskCriteria(path.join(snapshot.execution.factoryDir, task.taskFile)).map(
                  (criterion) => criterion.id,
                ),
          earlierFindings: earlierFindings(snapshot, session.taskId ?? '', run.semanticRound).map(
            (finding) => finding.id,
          ),
          lineCount: worktreeLines(worktree),
        },
        contract: run.resultContract ?? REVIEW_CONTRACT_V4,
        cwd: worktree,
        output: runOutput(run),
        resultError: run.resultError,
        resultStatus: run.resultStatus,
        reviewedDiffHash: run.diffHash,
        reviewModel: session.model,
        round: run.semanticRound,
        tools: stageTools('review'),
        workModel: workSession?.model ?? snapshot.execution.policy.models.work,
      }),
    );
  },
  version: REVIEW_VALIDATOR_VERSION,
};
