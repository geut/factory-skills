import type { FactorySnapshot, ReviewVerdict, RunRecord, Stage, TaskRecord } from '../domain.ts';

// Read-only views of a snapshot for cards, the widget, and the gallery.

export { runOutput } from '../stages/output.ts';

export function runVerdict(run: RunRecord): ReviewVerdict | null {
  if (run.resultStatus !== 'valid' || run.resultJson === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(run.resultJson);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'review' in parsed &&
      typeof parsed.review === 'object' &&
      parsed.review !== null &&
      'verdict' in parsed.review
    ) {
      const verdict = parsed.review.verdict;
      return verdict === 'approve' || verdict === 'changes_requested' || verdict === 'blocked'
        ? verdict
        : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function runTask(snapshot: FactorySnapshot, run: RunRecord): TaskRecord | null {
  const session = snapshot.sessions.find((item) => item.id === run.sessionId) ?? null;
  if (session === null || session.taskId === null) {
    return null;
  }
  return snapshot.tasks.find((task) => task.taskId === session.taskId) ?? null;
}

function pad(value: number, total: number): string {
  return String(value).padStart(Math.max(2, String(total).length), '0');
}

// `03`, padded to the width of the task count.
export function taskNumber(snapshot: FactorySnapshot, task: TaskRecord): string {
  return pad(task.ordinal, snapshot.tasks.length);
}

// `03/06 Overview page`
export function taskLabel(snapshot: FactorySnapshot, task: TaskRecord): string {
  const total = snapshot.tasks.length;
  const title = task.title.trim().length > 0 ? ` ${task.title.trim()}` : '';
  return `${pad(task.ordinal, total)}/${pad(total, total)}${title}`;
}

export function tasksDone(snapshot: FactorySnapshot): number {
  return snapshot.tasks.filter((task) => task.status === 'done').length;
}

// `2/6 done`, or null before the plan registers tasks.
export function progressText(snapshot: FactorySnapshot): string | null {
  const total = snapshot.tasks.length;
  return total === 0 ? null : `${tasksDone(snapshot)}/${total} done`;
}

// One line per task for the plan card: `01 Store the filter · after 02, 03`.
export function planItems(snapshot: FactorySnapshot): Array<string> {
  const total = snapshot.tasks.length;
  return [...snapshot.tasks]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((task) => {
      const after = task.blockedBy.length === 0 ? '' : ` · after ${task.blockedBy.join(', ')}`;
      return `${pad(task.ordinal, total)} ${task.title.trim()}${after}`;
    });
}

export function readyTasks(snapshot: FactorySnapshot): Array<TaskRecord> {
  const done = new Set(
    snapshot.tasks.filter((task) => task.status === 'done').map((task) => task.taskId),
  );
  return snapshot.tasks
    .filter((task) => task.status === 'pending' && task.blockedBy.every((item) => done.has(item)))
    .sort((left, right) => left.ordinal - right.ordinal);
}

// The task being worked on or reviewed, else the next ready one.
export function currentTask(snapshot: FactorySnapshot): TaskRecord | null {
  const active = snapshot.tasks
    .filter((task) => task.status === 'active' || task.status === 'blocked')
    .sort((left, right) => left.ordinal - right.ordinal);
  return active[0] ?? readyTasks(snapshot)[0] ?? null;
}

// The command the user is expected to run, if the ticket is waiting on them.
export function nextAction(snapshot: FactorySnapshot): string | null {
  const ref = snapshot.ticket.commandRef;
  const execution = snapshot.execution;
  if (execution.status === 'waiting_for_user') {
    return `/factory reply ${ref} "answer"`;
  }
  if (execution.status === 'ready_for_handoff') {
    return `/factory complete ${ref}`;
  }
  if (execution.status === 'resume_failed') {
    return `/factory retry ${ref}`;
  }
  if (execution.status === 'failed') {
    return execution.retry !== null ? `/factory retry ${ref}` : null;
  }
  if (execution.status !== 'paused') {
    return null;
  }
  if (execution.retry !== null) {
    return `/factory retry ${ref}`;
  }
  if (execution.statusReasonCode === 'review_isolation') {
    return 'Fix models.review in FACTORY.json, then start the ticket again';
  }
  // Only a notice that names the run that paused can take a reply.
  const asked = snapshot.attention.some((item) => item.status === 'open' && item.runId !== null);
  return asked ? `/factory reply ${ref} "answer"` : null;
}

export function needsUser(snapshot: FactorySnapshot): boolean {
  const status = snapshot.execution.status;
  return (
    status === 'waiting_for_user' ||
    status === 'ready_for_handoff' ||
    status === 'paused' ||
    status === 'resume_failed' ||
    status === 'failed'
  );
}

// The round of the task's latest review run, or null before its first review.
export function latestReviewRound(snapshot: FactorySnapshot, task: TaskRecord): number | null {
  const session =
    snapshot.sessions.find((item) => item.stage === 'review' && item.taskId === task.taskId) ??
    null;
  if (session === null) {
    return null;
  }
  const runs = snapshot.runs
    .filter((run) => run.sessionId === session.id)
    .sort((left, right) => right.sequence - left.sequence);
  return runs[0]?.semanticRound ?? null;
}

// `review r2`, `work`, or `fixing r1` after changes were requested.
export function stepLabel(snapshot: FactorySnapshot, task: TaskRecord): string {
  const stage = snapshot.execution.stage;
  if (stage === 'review') {
    const round = latestReviewRound(snapshot, task);
    return round === null ? 'review' : `review r${round}`;
  }
  const review = task.summaries.review;
  if (review?.label === 'changes_requested') {
    return `fixing r${review.round}`;
  }
  return 'work';
}

export type TicketProgress = {
  current: { label: string; step: string } | null;
  displayRef: string;
  done: number;
  needsUser: boolean;
  next: string | null;
  stage: Stage;
  status: string;
  total: number;
};

export function ticketProgress(snapshot: FactorySnapshot): TicketProgress {
  const task = currentTask(snapshot);
  const stage = snapshot.execution.stage;
  return {
    current:
      task === null || (stage !== 'work' && stage !== 'review')
        ? null
        : { label: taskLabel(snapshot, task), step: stepLabel(snapshot, task) },
    displayRef: snapshot.ticket.displayRef,
    done: tasksDone(snapshot),
    needsUser: needsUser(snapshot),
    next: nextAction(snapshot),
    stage,
    status:
      snapshot.execution.status === 'waiting_for_user'
        ? 'waiting for you'
        : snapshot.execution.status.replaceAll('_', ' '),
    total: snapshot.tasks.length,
  };
}

// `03/06 Overview page · review r1` while a task is in work or review.
export function currentStep(snapshot: FactorySnapshot): string | null {
  const current = ticketProgress(snapshot).current;
  return current === null ? null : `${current.label} · ${current.step}`;
}
