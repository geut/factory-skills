import type {
  ActionRecord,
  FactorySnapshot,
  ReviewVerdict,
  RunId,
  RunRecord,
  RunStatus,
  StageName,
  TerminalKind,
} from '../domain.ts';
import { runStatusLabel } from '../runtime/policy.ts';
import { stages } from '../stages/index.ts';
import { parseReview } from '../stages/review/parse.ts';
import { card, encodeCard, type CardTone, type FactoryCard } from './card.ts';
import {
  currentStep,
  nextAction,
  planItems,
  progressText,
  readyTasks,
  runOutput,
  runTask,
  runVerdict,
  taskLabel,
  taskNumber,
} from './progress.ts';

// Words for what a finished run led to, not for the run itself: a review run
// that ended is `approved`, never `done`.
export type RunOutcome =
  | 'approved'
  | 'blocked'
  | 'changes requested'
  | 'correcting'
  | 'diff changed'
  | 'failed'
  | 'finished'
  | 'paused'
  | 'planned'
  | 'ready for handoff'
  | 'ready for review'
  | 'retrying'
  | 'running'
  | 'waiting for you';

export type RunStage = StageName;

// Retries, replies, and corrections are named; first runs, returns to work,
// and later review rounds are not, because the round is shown on its own.
export function purposeSegment(run: Pick<RunRecord, 'purpose' | 'semanticRound'>): string | null {
  if (run.purpose === 'initial' || run.purpose === 'return_to_work' || run.purpose === 'reentry') {
    return null;
  }
  return runStatusLabel(run.purpose);
}

const verdictOutcomes: Record<ReviewVerdict, RunOutcome> = {
  approve: 'approved',
  blocked: 'blocked',
  changes_requested: 'changes requested',
};

export function classifyRun(input: {
  correctionScheduled: boolean;
  // A wrap-up run whose handoff passed validation.
  handoff?: boolean;
  limitPaused: boolean;
  retryScheduled: boolean;
  stage: RunStage;
  stale: boolean;
  status: RunStatus;
  terminalKind: TerminalKind | null;
  verdict: ReviewVerdict | null;
}): RunOutcome {
  if (input.status !== 'terminal') {
    return 'running';
  }
  if (input.terminalKind === 'caller_ping') {
    return 'waiting for you';
  }
  if (input.terminalKind !== 'subagent_done') {
    return input.retryScheduled ? 'retrying' : 'failed';
  }
  if (input.correctionScheduled) {
    return 'correcting';
  }
  if (input.stale) {
    return 'diff changed';
  }
  if (input.limitPaused) {
    return 'paused';
  }
  switch (input.stage) {
    case 'plan':
      return 'planned';
    case 'work':
      return 'ready for review';
    case 'review':
      return input.verdict === null ? 'correcting' : verdictOutcomes[input.verdict];
    case 'wrapup':
      return input.handoff === true ? 'ready for handoff' : 'finished';
    default:
      return 'finished';
  }
}

export function outcomeTone(outcome: RunOutcome): CardTone {
  switch (outcome) {
    case 'approved':
    case 'finished':
    case 'planned':
    case 'ready for handoff':
    case 'ready for review':
      return 'done';
    case 'blocked':
    case 'diff changed':
    case 'paused':
    case 'waiting for you':
      return 'attention';
    case 'failed':
      return 'failed';
    case 'changes requested':
    case 'correcting':
    case 'retrying':
    case 'running':
      return 'progress';
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

export function correctionScheduled(snapshot: FactorySnapshot, runId: RunId): boolean {
  const child = snapshot.runs.some(
    (run) => run.parentRunId === runId && run.purpose === 'validation_correction',
  );
  if (child) {
    return true;
  }
  return snapshot.actions.some((action) => correctsRun(action, runId));
}

// A stage pauses at its correction limit, or at its round limit.
const limitCode = /_(correction|round)_limit$/;

// Input prepared for a correction of `runId`, before that run exists.
export function correctsRun(action: ActionRecord, runId: RunId): boolean {
  return (
    action.kind === 'prepare_input' &&
    action.idempotencyKey.startsWith(`${action.stage}-input:${runId}:correction`)
  );
}

export function limitPaused(snapshot: FactorySnapshot, run: RunRecord): boolean {
  const code = snapshot.execution.statusReasonCode;
  if (snapshot.execution.status !== 'paused' || code === null || !limitCode.test(code)) {
    return false;
  }
  // The pause is about the run its notice names, else the latest run.
  const named = snapshot.attention.find((item) => item.status === 'open')?.runId ?? null;
  if (named !== null) {
    return named === run.id;
  }
  return runsInStartOrder(snapshot.runs).at(-1)?.id === run.id;
}

// The worktree changed while this review ran, so its verdict was not used.
export function staleReview(snapshot: FactorySnapshot, run: RunRecord): boolean {
  const suffix = `:stale:${run.id}`;
  if (snapshot.actions.some((action) => action.idempotencyKey.endsWith(suffix))) {
    return true;
  }
  return (
    snapshot.execution.statusReasonCode === 'review_diff_changed' &&
    snapshot.attention.some((item) => item.runId === run.id && item.status === 'open')
  );
}

export function runStage(snapshot: FactorySnapshot, run: RunRecord): RunStage {
  return snapshot.sessions.find((session) => session.id === run.sessionId)?.stage ?? 'plan';
}

export function runOutcome(snapshot: FactorySnapshot, run: RunRecord): RunOutcome {
  const stage = runStage(snapshot, run);
  return classifyRun({
    correctionScheduled: correctionScheduled(snapshot, run.id),
    handoff:
      stage === 'wrapup' &&
      snapshot.actions.some((action) => action.idempotencyKey === `pane:session:${run.id}`),
    limitPaused: limitPaused(snapshot, run),
    retryScheduled: snapshot.runs.some(
      (other) => other.parentRunId === run.id && other.purpose === 'infrastructure_retry',
    ),
    stage,
    stale: stage === 'review' && staleReview(snapshot, run),
    status: run.status,
    terminalKind: run.terminalKind,
    verdict: runVerdict(run),
  });
}

function startMillis(startedAt: string | null): number {
  if (startedAt === null) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(startedAt);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export function runsInStartOrder<T extends { startedAt: string | null }>(runs: Array<T>): Array<T> {
  return runs
    .map((run, index) => ({ index, run }))
    .sort((left, right) => {
      const byStart = startMillis(left.run.startedAt) - startMillis(right.run.startedAt);
      return byStart === 0 ? left.index - right.index : byStart;
    })
    .map((item) => item.run);
}

// A stage's rounds count from 1; work shows the round whose findings it fixes.
function runRound(snapshot: FactorySnapshot, run: RunRecord): number | null {
  const stage = runStage(snapshot, run);
  if (stages[stage].rounds || run.purpose === 'return_to_work') {
    return run.semanticRound > 0 ? run.semanticRound : null;
  }
  return null;
}

// `review · 03/06 · r1 · approved`
export function runListLabel(snapshot: FactorySnapshot, run: RunRecord): string {
  const task = runTask(snapshot, run);
  const round = runRound(snapshot, run);

  return [
    runStage(snapshot, run),
    task === null ? null : taskNumber(snapshot, task),
    round === null ? null : `r${round}`,
    purposeSegment(run),
    runOutcome(snapshot, run),
  ]
    .filter((part) => part !== null && part.length > 0)
    .join(' · ');
}

export function firstSummaryLine(text: string): string {
  const line = text
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !/^#{1,6}\s/.test(item));
  return line ?? '';
}

function reviewItems(run: RunRecord, outcome: RunOutcome): Array<string> {
  if (outcome !== 'changes requested' && outcome !== 'blocked' && outcome !== 'paused') {
    return [];
  }
  const parsed = parseReview(runOutput(run), run.semanticRound);
  if (parsed.kind === 'invalid') {
    return [];
  }
  return parsed.result.findings
    .filter((finding) => finding.blocking || outcome === 'blocked')
    .map((finding) => `${finding.id} [${finding.severity}] ${finding.title}`);
}

export function runCard(snapshot: FactorySnapshot, run: RunRecord, summary: string): FactoryCard {
  const stage = runStage(snapshot, run);
  const outcome = runOutcome(snapshot, run);
  const purpose = purposeSegment(run);
  const task = runTask(snapshot, run);
  const tone = outcomeTone(outcome);
  const planned = stage === 'plan' && outcome === 'planned' && snapshot.tasks.length > 0;
  const ready = readyTasks(snapshot).map((item) => taskNumber(snapshot, item));
  const count = snapshot.tasks.length;
  return card({
    body: planned
      ? `${count} task${count === 1 ? '' : 's'} planned${ready.length > 0 ? ` · ready: ${ready.join(', ')}` : ''}`
      : summary,
    displayRef: snapshot.ticket.displayRef,
    items: planned ? planItems(snapshot) : stage === 'review' ? reviewItems(run, outcome) : [],
    next: tone === 'attention' || tone === 'failed' ? nextAction(snapshot) : null,
    outcome: purpose === null ? outcome : `${purpose} · ${outcome}`,
    progress: progressText(snapshot),
    round: runRound(snapshot, run),
    stage,
    task: task === null ? null : taskLabel(snapshot, task),
    tone,
  });
}

export function finishedRunCard(
  snapshot: FactorySnapshot,
  run: RunRecord,
  summary: string,
): string {
  return encodeCard(runCard(snapshot, run, summary));
}

// A question or pause notice. It names the task and the command to run.
export function attentionCard(snapshot: FactorySnapshot, message: string): string {
  const status = snapshot.execution.status;
  return encodeCard(
    card({
      body: message,
      displayRef: snapshot.ticket.displayRef,
      next: nextAction(snapshot),
      outcome: status === 'waiting_for_user' ? 'waiting for you' : status.replaceAll('_', ' '),
      progress: progressText(snapshot),
      stage: snapshot.execution.stage,
      task: currentStep(snapshot),
      tone: status === 'failed' ? 'failed' : 'attention',
    }),
  );
}
