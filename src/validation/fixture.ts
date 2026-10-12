import type { FactorySnapshot, RunRecord, SessionRecord } from '../domain.ts';
import { blank, run, session } from '../stories/fixtures.ts';
import type { ValidatedStage, ValidationContext } from './report.ts';

// A validator's context for tests: a finished run of `stage` in an otherwise
// blank snapshot. `edit` points the snapshot at the test's worktree or files.
export function validationContext(
  stage: ValidatedStage,
  edit: (snapshot: FactorySnapshot, finished: RunRecord, owner: SessionRecord) => void = () => {},
  deps: Partial<ValidationContext['deps']> = {},
): ValidationContext {
  const snapshot = blank();
  const owner = session(snapshot, stage, stage === 'work' || stage === 'review' ? '01' : null);
  const finished = run(snapshot, owner);
  edit(snapshot, finished, owner);
  return {
    deps: {
      findPullRequest: deps.findPullRequest ?? (() => ({ missing: true })),
      usage: deps.usage ?? (() => ''),
    },
    run: finished,
    session: owner,
    snapshot,
  };
}
