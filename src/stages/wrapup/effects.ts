import path from 'node:path';
import { inspectWrapupInput } from '../../actions/wrapup-input.ts';
import type { FactorySnapshot } from '../../domain.ts';
import { captureWrapupState } from '../../validation/wrapup.ts';
import type { InputContext, InputResult } from '../effects.ts';
import type { WrapupPrepared } from './definition.ts';

function wrapupRuns(snapshot: FactorySnapshot) {
  const session = snapshot.sessions.find((item) => item.stage === 'wrapup') ?? null;
  return session === null ? [] : snapshot.runs.filter((run) => run.sessionId === session.id);
}

// Checks the wrap-up input outside the controller transaction, so the reducer
// can create the run atomically from what it found.
export function prepareWrapupInput({ deps, snapshot }: InputContext): InputResult<WrapupPrepared> {
  const factoryRoot = path.dirname(path.dirname(snapshot.execution.factoryDir));
  const inspection = inspectWrapupInput({
    activeChild: snapshot.runs.some((run) => run.status !== 'terminal'),
    executionCurrent: deps.executionCurrent,
    factoryRoot,
    snapshot,
  });
  if (inspection.kind === 'failed') {
    return { kind: 'failed', message: inspection.failures.join('\n') };
  }
  // Corrections and replies compare against the state before the first run.
  let baseline = wrapupRuns(snapshot).find((run) => run.baseline !== null)?.baseline ?? null;
  if (baseline === null) {
    const { worktreeBaseSha, worktreeBranch, worktreePath } = snapshot.execution;
    if (worktreeBaseSha === null || worktreeBranch === null || worktreePath === null) {
      return { kind: 'failed', message: 'The worktree is not ready for this execution.' };
    }
    try {
      baseline = JSON.stringify(
        captureWrapupState({
          baseBranch: snapshot.execution.worktreeBaseBranch,
          baseSha: worktreeBaseSha,
          branch: worktreeBranch,
          codeRoot: snapshot.execution.policy.codeRoot,
          factoryRoot,
          worktree: worktreePath,
        }),
      );
    } catch (error: unknown) {
      return {
        kind: 'failed',
        message: `Cannot read the worktree: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return {
    input: {
      adrPath: inspection.adrPath,
      baseline,
      contextPath: inspection.contextPath,
      usage: deps.usage(),
      verification: deps.workChecks(),
    },
    kind: 'ready',
  };
}
