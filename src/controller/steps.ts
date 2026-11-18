import type { DatabaseSync } from 'node:sqlite';
import type { ActionRecord, FactorySnapshot, RunRecord } from '../domain.ts';
import { stages } from '../stages/index.ts';
import type { CommandProgress } from './command-progress.ts';
import { taskNumber } from './progress.ts';
import { listCurrentTicketRefs, loadCurrentByTicketKey, ticketKeyOf } from './store.ts';

// A controller step: what the controller is doing for a ticket between
// agents (GLOSSARY.md), from its actions. `running` is the action it holds a
// lease on; `queued` is the next one waiting its turn.

export type ControllerStep = {
  // The command a long step is running, from the server's memory: null
  // between commands, for other steps, and to a reader with only the database.
  command: CommandProgress | null;
  kind: ActionRecord['kind'];
  // For a person: `validating task 02's work`.
  label: string;
  // When it started running, or was queued.
  since: string;
  state: 'queued' | 'running';
};

// An action's times: when it was queued, and when it last changed status,
// which for a running action is when it was claimed.
export type ActionTimes = Map<string, { createdAt: string; updatedAt: string }>;

function runOf(snapshot: FactorySnapshot, action: { runId: RunRecord['id'] }) {
  const run = snapshot.runs.find((item) => item.id === action.runId) ?? null;
  const session =
    run === null ? null : (snapshot.sessions.find((item) => item.id === run.sessionId) ?? null);
  return session;
}

// `task 02's work`, `the plan`, `wrap-up`: a stage, for a task when it runs per task.
function stageWork(
  snapshot: FactorySnapshot,
  stage: keyof typeof stages,
  taskId: string | null,
): string {
  const task = taskId === null ? null : snapshot.tasks.find((item) => item.taskId === taskId);
  const name = stages[stage].label.toLowerCase();
  if (task === null || task === undefined) {
    return stage === 'plan' ? 'the plan' : name;
  }
  return `task ${taskNumber(snapshot, task)}'s ${name}`;
}

function runWork(snapshot: FactorySnapshot, action: { runId: RunRecord['id'] }): string {
  const session = runOf(snapshot, action);
  return session === null ? 'a run' : stageWork(snapshot, session.stage, session.taskId);
}

function runAgent(snapshot: FactorySnapshot, action: { runId: RunRecord['id'] }): string {
  const session = runOf(snapshot, action);
  if (session === null) {
    return 'an agent';
  }
  const task =
    session.taskId === null
      ? undefined
      : snapshot.tasks.find((item) => item.taskId === session.taskId);
  const name = stages[session.stage].label.toLowerCase();
  return task === undefined
    ? `the ${name} agent`
    : `the ${name} agent for task ${taskNumber(snapshot, task)}`;
}

export function stepLabel(snapshot: FactorySnapshot, action: ActionRecord): string {
  switch (action.kind) {
    case 'prepare_worktree':
      return 'preparing the worktree';
    case 'prepare_input':
      return `preparing ${stageWork(snapshot, action.stage, action.taskId)}`;
    case 'launch_run':
      return `${action.mode === 'resume' ? 'resuming' : 'starting'} ${runAgent(snapshot, action)}`;
    case 'resume_run':
      return `resuming ${runAgent(snapshot, action)} with the reply`;
    case 'validate_run':
      return `validating ${runWork(snapshot, action)}`;
    case 'notify_attention':
      return 'posting a notice';
    case 'update_ticket_source':
      return 'updating the issue';
    case 'update_pull_request':
      return action.change.kind === 'body'
        ? 'updating the pull request'
        : 'commenting on the pull request';
    case 'open_pane':
    case 'open_diff':
      return 'opening the handoff panes';
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

// The ticket's controller step: the action it is running, else the next one
// queued; null when it has none.
export function controllerStep(
  snapshot: FactorySnapshot,
  times: ActionTimes,
  commandOf: (actionId: string) => CommandProgress | null = () => null,
): ControllerStep | null {
  const active = snapshot.actions.filter(
    (action) => action.status === 'leased' || action.status === 'pending',
  );
  const action = active.find((item) => item.status === 'leased') ?? active[0];
  if (action === undefined) {
    return null;
  }
  const at = times.get(action.id);
  const running = action.status === 'leased';
  return {
    command: running ? commandOf(action.id) : null,
    kind: action.kind,
    label: stepLabel(snapshot, action),
    since: (running ? at?.updatedAt : at?.createdAt) ?? new Date().toISOString(),
    state: running ? 'running' : 'queued',
  };
}

export function actionTimes(db: DatabaseSync, executionId: string): ActionTimes {
  const rows = db
    .prepare(
      `SELECT id, created_at, updated_at FROM actions
       WHERE execution_id = ? AND status IN ('pending', 'leased')`,
    )
    .all(executionId);
  return new Map(
    rows.map((row) => [
      String(row['id']),
      { createdAt: String(row['created_at']), updatedAt: String(row['updated_at']) },
    ]),
  );
}

export type TicketStep = { displayRef: string; step: ControllerStep; ticket: string };

// The controller steps of current tickets, for Pi and the API.
export function controllerStepsOf(
  db: DatabaseSync,
  commandOf: (actionId: string) => CommandProgress | null = () => null,
): Array<TicketStep> {
  return listCurrentTicketRefs(db).flatMap((ref) => {
    const snapshot = loadCurrentByTicketKey(db, ref);
    if (snapshot === null) {
      return [];
    }
    const step = controllerStep(snapshot, actionTimes(db, snapshot.execution.id), commandOf);
    return step === null
      ? []
      : [{ displayRef: snapshot.ticket.displayRef, step, ticket: ticketKeyOf(snapshot) }];
  });
}

// Changes whenever an action is queued or changes status, which records no
// event: Pi refreshes its controller steps when it does.
export function actionsVersion(db: DatabaseSync): string {
  const row = db.prepare('SELECT count(*) AS n, max(updated_at) AS at FROM actions').get();
  return `${String(row?.['n'] ?? 0)}:${String(row?.['at'] ?? '')}`;
}

// The kinds of step that run the controller's own commands: Pi asks the
// server which one while such a step runs.
export function runsCommands(step: ControllerStep): boolean {
  return (
    step.state === 'running' && (step.kind === 'validate_run' || step.kind === 'prepare_worktree')
  );
}
