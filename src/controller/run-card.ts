import type { FactorySnapshot, RunId, RunRecord, RunStatus, TerminalKind } from '../domain.ts';
import { runStatusLabel } from '../runtime/policy.ts';

export type RunOutcome = 'checks failed' | 'done' | 'failed' | 'needs you' | 'running';

export function purposeSegment(run: Pick<RunRecord, 'purpose' | 'semanticRound'>): string | null {
  if (run.purpose === 'initial') {
    return null;
  }
  const label = runStatusLabel(run.purpose);
  if (run.purpose === 'validation_correction') {
    return `${label} ${run.semanticRound}`;
  }
  return label;
}

export function classifyRun(input: {
  correctionScheduled: boolean;
  limitPaused: boolean;
  status: RunStatus;
  terminalKind: TerminalKind | null;
}): RunOutcome {
  if (input.status !== 'terminal') {
    return 'running';
  }
  if (input.terminalKind === 'caller_ping') {
    return 'needs you';
  }
  if (input.terminalKind !== 'subagent_done') {
    return 'failed';
  }
  if (input.correctionScheduled || input.limitPaused) {
    return 'checks failed';
  }
  return 'done';
}

export function correctionScheduled(snapshot: FactorySnapshot, runId: RunId): boolean {
  const child = snapshot.runs.some(
    (run) => run.parentRunId === runId && run.purpose === 'validation_correction',
  );
  if (child) {
    return true;
  }
  const prefix = `work-input:${runId}:correction:`;
  return snapshot.actions.some((action) => action.idempotencyKey.startsWith(prefix));
}

export function limitPaused(snapshot: FactorySnapshot, run: RunRecord): boolean {
  const code = snapshot.execution.statusReasonCode;
  if (
    snapshot.execution.status !== 'paused' ||
    (code !== 'plan_correction_limit' && code !== 'work_correction_limit')
  ) {
    return false;
  }
  return !snapshot.runs.some(
    (other) => other.sessionId === run.sessionId && other.sequence > run.sequence,
  );
}

export function runStage(snapshot: FactorySnapshot, run: RunRecord): string {
  return snapshot.sessions.find((session) => session.id === run.sessionId)?.stage ?? 'plan';
}

export function runOutcome(snapshot: FactorySnapshot, run: RunRecord): RunOutcome {
  return classifyRun({
    correctionScheduled: correctionScheduled(snapshot, run.id),
    limitPaused: limitPaused(snapshot, run),
    status: run.status,
    terminalKind: run.terminalKind,
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

export function runListLabel(snapshot: FactorySnapshot, run: RunRecord): string {
  return [runStage(snapshot, run), purposeSegment(run), runOutcome(snapshot, run)]
    .filter((part) => part !== null && part.length > 0)
    .join(' · ');
}

export function formatRunCard(input: {
  displayRef: string;
  outcome: string;
  purposeLabel: string | null;
  stage: string;
  summary: string;
}): string {
  const status =
    input.purposeLabel === null ? input.outcome : `${input.purposeLabel} · ${input.outcome}`;
  const lines = [input.displayRef, `stage: ${input.stage}`, `status: ${status}`];
  if (input.summary.length > 0) {
    lines.push(input.summary);
  }
  return lines.join('\n');
}

export function firstSummaryLine(text: string): string {
  const line = text
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !/^#{1,6}\s/.test(item));
  return line ?? '';
}

export function finishedRunCard(
  snapshot: FactorySnapshot,
  run: RunRecord,
  summary: string,
): string {
  return formatRunCard({
    displayRef: snapshot.ticket.displayRef,
    outcome: runOutcome(snapshot, run),
    purposeLabel: purposeSegment(run),
    stage: runStage(snapshot, run),
    summary,
  });
}
