import type { FactorySnapshot, RunId, WrapupBaseline } from '../domain.ts';
import { latestPassRun, passBaselineText, rebasedRefusal } from '../stages/wrapup/rebased.ts';
import { roundStart } from '../validation/bases.ts';
import { carryPassOver, type CarriedPass } from '../validation/rebased.ts';
import { parseBaseline } from '../validation/wrapup.ts';

// `/factory retry --rebased`: reads git for the pass carried over to the
// rebased branch, before the controller applies it.

// The pass carried over to the rebased branch, read from git before the
// event: the reducer checks the pass is still the one read, so a pass that
// moved on meanwhile is refused rather than overwritten.
export function readRebased(snapshot: FactorySnapshot):
  | {
      kind: 'carried';
      pass: CarriedPass;
      previous: string;
      previousBaseline: WrapupBaseline;
      runId: RunId;
    }
  | {
      kind: 'refused';
      message: string;
    } {
  const refusal = rebasedRefusal(snapshot);
  if (refusal !== null) {
    return { kind: 'refused', message: refusal };
  }
  const run = latestPassRun(snapshot);
  const previous = passBaselineText(snapshot);
  const baseline = previous === null ? null : parseBaseline(previous);
  const { worktreeBaseSha, worktreePath } = snapshot.execution;
  if (
    run === null ||
    previous === null ||
    baseline === null ||
    worktreeBaseSha === null ||
    worktreePath === null
  ) {
    return {
      kind: 'refused',
      message: `${snapshot.ticket.displayRef} has no wrap-up pass to carry over.`,
    };
  }
  const carried = carryPassOver({
    baseBranch: snapshot.execution.worktreeBaseBranch,
    baseline,
    branched: worktreeBaseSha,
    codeRoot: snapshot.execution.policy.codeRoot,
    roundStart: roundStart(snapshot),
    worktree: worktreePath,
  });
  return carried.kind === 'refused'
    ? carried
    : {
        kind: 'carried',
        pass: carried.pass,
        previous,
        previousBaseline: baseline,
        runId: run.id,
      };
}

function short(sha: string | null): string {
  return sha === null ? 'where the ticket branched' : sha.slice(0, 12);
}

// The first paths of a list, and how many more.
function sample(files: Array<string>): string {
  return files.length === 0
    ? 'none'
    : `${files.slice(0, 20).join(', ')}${files.length > 20 ? `, and ${files.length - 20} more` : ''}`;
}

// What --rebased would do, changing nothing but the worktree's refs.
export function rebasedPreview(
  snapshot: FactorySnapshot,
): { kind: 'preview'; text: string } | { kind: 'refused'; message: string } {
  const read = readRebased(snapshot);
  if (read.kind === 'refused') {
    return read;
  }
  const { pass, previousBaseline } = read;
  const text = [
    `${snapshot.ticket.displayRef}: --rebased would carry the wrap-up pass over to the rebased branch, then validate again.`,
    `compare base: ${short(previousBaseline.compareBase)} → ${short(pass.baseline.compareBase)}`,
    `pass start: ${short(previousBaseline.head)} → ${short(pass.baseline.head)}`,
    ...(pass.roundStart === null
      ? []
      : [`feedback round start: ${short(roundStart(snapshot))} → ${short(pass.roundStart)}`]),
    `dropped as the target's own (${pass.dropped.length}): ${sample(pass.dropped)}`,
    `kept (${pass.kept.length}): ${sample(pass.kept)}`,
    'Nothing changed.',
  ].join('\n');
  return { kind: 'preview', text };
}
