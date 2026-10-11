import type { ReviewValidationReport } from '../domain.ts';
import { sha256 } from '../hash.ts';
import { stageTools } from '../stages/index.ts';
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
  currentDiffHash: string;
  resultError: string | null;
  resultStatus: 'pending' | 'valid' | 'invalid';
  reviewedDiffHash: string | null;
  reviewModel: string;
  tools: string;
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
      ? []
      : (input.resultError ?? 'The review result was not parsed.')
          .split('\n')
          .filter((line) => line.length > 0);
  const schema: ValidationCheck = {
    details: schemaFailures.length === 0 ? 'factory.review.v4' : schemaFailures.join('\n'),
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

function validateReview(input: {
  cwd: string;
  resultError: string | null;
  resultStatus: 'pending' | 'valid' | 'invalid';
  reviewedDiffHash: string | null;
  reviewModel: string;
  tools: string;
  workModel: string;
}): ReviewValidationReport {
  const collected = collectWorkDiff(input.cwd);
  if ('message' in collected) {
    return errorReport(REVIEW_VALIDATOR_VERSION, collected.message);
  }
  return reviewChecks({ ...input, currentDiffHash: sha256(collected.diff) });
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
    return Promise.resolve(
      validateReview({
        cwd: worktree,
        resultError: run.resultError,
        resultStatus: run.resultStatus,
        reviewedDiffHash: run.diffHash,
        reviewModel: session.model,
        tools: stageTools('review'),
        workModel: workSession?.model ?? snapshot.execution.policy.models.work,
      }),
    );
  },
  version: REVIEW_VALIDATOR_VERSION,
};
