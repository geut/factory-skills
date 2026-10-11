import { formatUsageTable } from '../controller/usage.ts';
import { attentionId, taskId, type FactorySnapshot, type RunRecord } from '../domain.ts';
import {
  action,
  addTasks,
  at,
  blank,
  majorFinding,
  minorFinding,
  pause,
  planned,
  review,
  run,
  secondMajor,
  session,
  setTask,
  staleAction,
  third,
} from './fixtures.ts';

// Moments in one ticket's life. Each scenario is a snapshot plus the run a
// status card is about.

export type Scenario = { question?: string; run: RunRecord | null; snapshot: FactorySnapshot };

const workDone = 'All checks green. The overview page renders from the v2 read module.';

export function planReady(longTitles = false): Scenario {
  const { run: plan, snapshot } = planned({ longTitles });
  return { run: plan, snapshot };
}

export function planRunning(): Scenario {
  const snapshot = blank();
  const plan = run(snapshot, session(snapshot, 'plan'), { minutesAgo: 2, terminal: null });
  return { run: plan, snapshot };
}

export function working(): Scenario {
  const snapshot = third();
  const work = run(snapshot, session(snapshot, 'work', '03'), { minutesAgo: 3, terminal: null });
  return { run: work, snapshot };
}

export function readyForReview(): Scenario {
  const snapshot = third();
  setTask(snapshot, '03', { stage: 'review' });
  const work = run(snapshot, session(snapshot, 'work', '03'), { minutesAgo: 12, output: workDone });
  run(snapshot, session(snapshot, 'review', '03'), { minutesAgo: 1, round: 1, terminal: null });
  snapshot.execution.stage = 'review';
  return { run: work, snapshot };
}

export function approvedNext(): Scenario {
  const snapshot = third();
  run(snapshot, session(snapshot, 'work', '03'), { minutesAgo: 12, output: workDone });
  const verdict = run(snapshot, session(snapshot, 'review', '03'), {
    minutesAgo: 6,
    output: review('approve', minorFinding, 'The overview page meets every acceptance criterion.'),
    round: 1,
  });
  setTask(snapshot, '03', 'done', { findings: 1, round: 1, verdict: 'approve' });
  setTask(snapshot, '04', { stage: 'work' });
  snapshot.execution.stage = 'work';
  return { run: verdict, snapshot };
}

function changes(round: number): Scenario {
  const snapshot = third();
  const work = session(snapshot, 'work', '03');
  const reviewer = session(snapshot, 'review', '03');
  // Work, review, fix, review…: five minutes apart, oldest first.
  let minutesAgo = 60;
  run(snapshot, work, { minutesAgo, output: workDone });
  let last: RunRecord | null = null;
  for (let index = 1; index <= round; index += 1) {
    if (index > 1) {
      minutesAgo -= 5;
      run(snapshot, work, {
        minutesAgo,
        output: workDone,
        purpose: 'return_to_work',
        round: index - 1,
      });
    }
    minutesAgo -= 5;
    last = run(snapshot, reviewer, {
      minutesAgo,
      output: review(
        'changes_requested',
        `${majorFinding}\n\n${secondMajor}\n\n${minorFinding}`,
        'Two blocking problems remain in the error path.',
      ),
      purpose: index === 1 ? 'initial' : 'reentry',
      round: index,
    });
  }
  setTask(
    snapshot,
    '03',
    { stage: 'work' },
    {
      blocking: 2,
      findings: 3,
      round,
      verdict: 'changes_requested',
    },
  );
  snapshot.execution.stage = 'work';
  return { run: last, snapshot };
}

export function changesRequested(): Scenario {
  const scenario = changes(2);
  // The worker is fixing round 2's findings.
  run(scenario.snapshot, session(scenario.snapshot, 'work', '03'), {
    minutesAgo: 1,
    purpose: 'return_to_work',
    round: 2,
    terminal: null,
  });
  return scenario;
}

export function roundLimit(): Scenario {
  const scenario = changes(3);
  const { snapshot } = scenario;
  setTask(snapshot, '03', { blocked: true, stage: 'review' });
  snapshot.execution.stage = 'review';
  const question = [
    'Review round 3 of 3 for task 03 still has blocking findings:',
    '- R3-1 [major] Missing DB_URL bypasses the typed error page',
    '- R3-2 [critical] The detail lookup can return a ticket with id "undefined"',
    'Reply to tell the reviewer how to settle them.',
  ].join('\n');
  pause(snapshot, { code: 'review_round_limit', question, runId: scenario.run });
  return { ...scenario, question };
}

export function blockedVerdict(): Scenario {
  const snapshot = third();
  run(snapshot, session(snapshot, 'work', '03'), { minutesAgo: 12, output: workDone });
  const verdict = run(snapshot, session(snapshot, 'review', '03'), {
    minutesAgo: 2,
    output: review('blocked', 'none', 'The task file is missing, so the scope cannot be checked.'),
    round: 1,
  });
  setTask(snapshot, '03', { blocked: true, stage: 'review' }, { round: 1, verdict: 'blocked' });
  snapshot.execution.stage = 'review';
  const question = [
    'The reviewer blocked task 03: The task file is missing, so the scope cannot be checked.',
    'Reply to resume the reviewer with what it needs.',
  ].join('\n');
  pause(snapshot, { code: 'review_blocked', question, runId: verdict });
  return { question, run: verdict, snapshot };
}

export function malformed(): Scenario {
  const snapshot = third();
  setTask(snapshot, '03', { stage: 'review' });
  run(snapshot, session(snapshot, 'work', '03'), { minutesAgo: 12, output: workDone });
  const reviewer = session(snapshot, 'review', '03');
  const bad = run(snapshot, reviewer, { minutesAgo: 4, output: 'Looks good to me.', round: 1 });
  run(snapshot, reviewer, {
    minutesAgo: 1,
    parent: bad,
    purpose: 'validation_correction',
    round: 1,
    terminal: null,
  });
  snapshot.execution.stage = 'review';
  return { run: bad, snapshot };
}

export function correctionLimit(): Scenario {
  const snapshot = third();
  setTask(snapshot, '03', { blocked: true, stage: 'work' });
  run(snapshot, session(snapshot, 'work', '03'), { minutesAgo: 30, output: workDone });
  const reviewer = session(snapshot, 'review', '03');
  let last = run(snapshot, reviewer, { minutesAgo: 20, output: 'fine', round: 1 });
  for (let index = 0; index < 3; index += 1) {
    last = run(snapshot, reviewer, {
      minutesAgo: 15 - index * 4,
      output: 'still fine',
      parent: last,
      purpose: 'validation_correction',
      round: 1,
    });
  }
  snapshot.execution.stage = 'review';
  const question = [
    'The review result is still malformed after the correction limit:',
    '- ## Verdict is missing.',
    '- ## Summary is missing or empty.',
    'Reply to resume the reviewer.',
  ].join('\n');
  pause(snapshot, { code: 'review_correction_limit', question, runId: last });
  return { question, run: last, snapshot };
}

export function staleDiff(): Scenario {
  const snapshot = third();
  const work = run(snapshot, session(snapshot, 'work', '03'), { minutesAgo: 12, output: workDone });
  const stale = run(snapshot, session(snapshot, 'review', '03'), {
    minutesAgo: 4,
    output: review('approve'),
    round: 1,
  });
  staleAction(snapshot, work, stale);
  setTask(snapshot, '03', { stage: 'work' });
  snapshot.execution.stage = 'work';
  return { run: stale, snapshot };
}

export function diffKeepsChanging(): Scenario {
  const scenario = staleDiff();
  const { snapshot } = scenario;
  const again = run(snapshot, session(snapshot, 'review', '03'), {
    minutesAgo: 1,
    output: review('approve'),
    round: 1,
  });
  setTask(snapshot, '03', { blocked: true, stage: 'review' });
  snapshot.execution.stage = 'review';
  const question = [
    'The worktree changed again while review round 1 of task 03 ran.',
    'Something keeps writing files the diff includes. Check git status in /repo/.factory/worktrees/dpaez-factory-dashboard-11 and ignore generated files.',
    'Then run /factory retry dpaez/factory-dashboard#11 to validate the work and review it again.',
  ].join('\n');
  pause(snapshot, {
    code: 'review_diff_changed',
    question,
    retry: { kind: 'revalidate', taskId: taskId('03') },
    runId: again,
  });
  return { question, run: again, snapshot };
}

export function workChecksFailed(): Scenario {
  const snapshot = third();
  const work = session(snapshot, 'work', '03');
  const failed = run(snapshot, work, { minutesAgo: 8, output: workDone });
  run(snapshot, work, {
    minutesAgo: 1,
    parent: failed,
    purpose: 'validation_correction',
    terminal: null,
  });
  snapshot.execution.statusReason = 'test: npm test exited with 1';
  return { run: failed, snapshot };
}

export function askingUser(): Scenario {
  const snapshot = third();
  const question = 'Should the overview hide done tickets, or show them below the active ones?';
  const ping = run(snapshot, session(snapshot, 'work', '03'), {
    minutesAgo: 2,
    terminal: 'caller_ping',
  });
  pause(snapshot, { code: 'agent_question', question, runId: ping, waiting: true });
  return { question, run: ping, snapshot };
}

export function crashedRetry(): Scenario {
  const snapshot = third();
  setTask(snapshot, '03', { stage: 'review' });
  run(snapshot, session(snapshot, 'work', '03'), { minutesAgo: 12, output: workDone });
  const reviewer = session(snapshot, 'review', '03');
  const crashed = run(snapshot, reviewer, { minutesAgo: 6, round: 1, terminal: 'crashed' });
  run(snapshot, reviewer, {
    minutesAgo: 1,
    parent: crashed,
    purpose: 'infrastructure_retry',
    round: 1,
    terminal: null,
  });
  snapshot.execution.stage = 'review';
  return { run: crashed, snapshot };
}

export function wrapupRunning(): Scenario {
  const { snapshot } = planned();
  let last: RunRecord | null = null;
  for (const item of snapshot.tasks) {
    const offset = (snapshot.tasks.length - item.ordinal) * 30;
    run(snapshot, session(snapshot, 'work', item.taskId), {
      minutesAgo: offset + 25,
      output: workDone,
    });
    last = run(snapshot, session(snapshot, 'review', item.taskId), {
      minutesAgo: offset + 10,
      output: review('approve', minorFinding),
      round: 1,
    });
    setTask(snapshot, item.taskId, 'done', { findings: 1, round: 1, verdict: 'approve' });
  }
  run(snapshot, session(snapshot, 'wrapup'), { minutesAgo: 1, terminal: null });
  snapshot.execution.stage = 'wrapup';
  return { run: last, snapshot };
}

// A second ticket, for the widget's multi-ticket rows.
export function otherTicket(): FactorySnapshot {
  const snapshot = blank({ displayRef: 'geut/factory-skills#12', title: 'Add /factory stop' });
  addTasks(snapshot, 2);
  setTask(snapshot, '01', { stage: 'review' });
  run(snapshot, session(snapshot, 'review', '01'), { minutesAgo: 2, round: 1, terminal: null });
  snapshot.execution.stage = 'review';
  return snapshot;
}

const sampleUsage = formatUsageTable([
  {
    cacheRead: 135_000,
    cacheWrite: 22_000,
    context: 41.2,
    costMicros: 754_000,
    input: 28,
    label: 'Plan',
    models: ['qwen3.8-max'],
    output: 6900,
    sessions: 1,
    total: 163_928,
  },
  {
    cacheRead: 590_000,
    cacheWrite: 31_000,
    context: 63.5,
    costMicros: 6_105_000,
    input: 610,
    label: 'Work',
    models: ['qwen3.8-max'],
    output: 48_000,
    sessions: 6,
    total: 669_610,
  },
  {
    cacheRead: 300_000,
    cacheWrite: 12_000,
    context: 38,
    costMicros: 5_800_000,
    input: 480,
    label: 'Review',
    models: ['kimi-k3'],
    output: 25_200,
    sessions: 6,
    total: 337_680,
  },
  {
    cacheRead: 40_000,
    cacheWrite: 1500,
    context: 22.4,
    costMicros: 178_000,
    input: 20,
    label: 'Wrap-up',
    models: ['qwen3.8-max'],
    output: 1400,
    sessions: 1,
    total: 42_920,
  },
  {
    cacheRead: 1_065_000,
    cacheWrite: 66_500,
    context: null,
    costMicros: 12_837_000,
    input: 1138,
    label: 'Total',
    models: [],
    output: 81_500,
    sessions: 14,
    total: 1_214_138,
  },
]);

const handoffText = `## Outcome

The dashboard reads the factory's schema v2 database, read-only.

## PR summary

Move every page onto a typed read module over the controller views.
`;

function wrapupFinished(): Scenario {
  const scenario = wrapupRunning();
  const { snapshot } = scenario;
  const wrapup = snapshot.runs.at(-1);
  if (wrapup === undefined) {
    throw new Error('missing wrap-up run');
  }
  wrapup.status = 'terminal';
  wrapup.terminalKind = 'subagent_done';
  wrapup.endedAt = at(0);
  wrapup.resultJson = JSON.stringify({ output: handoffText });
  return { run: wrapup, snapshot };
}

// Wrap-up validation passed: panes queued, the human is asked to complete.
export function handoffReady(): Scenario {
  const scenario = wrapupFinished();
  const { run, snapshot } = scenario;
  if (run === null) {
    return scenario;
  }
  action(snapshot, `pane:session:${run.id}`, 'open_pane', run);
  action(snapshot, `pane:diff:${run.id}`, 'open_diff', run);
  snapshot.execution.status = 'ready_for_handoff';
  const question = [
    `${snapshot.ticket.displayRef} is ready for handoff. The wrap-up session and the diff are open in their own panes.`,
    '',
    sampleUsage,
    '',
    `Merge it yourself, then run /factory complete ${snapshot.ticket.commandRef}.`,
  ].join('\n');
  snapshot.attention.push({
    id: attentionId('attention-handoff'),
    kind: 'manual_approval',
    question,
    runId: run.id,
    status: 'open',
  });
  return { question, run, snapshot };
}

// Wrap-up validation failed; the same session is resumed with the failures.
export function wrapupCorrecting(): Scenario {
  const scenario = wrapupFinished();
  const { run, snapshot } = scenario;
  if (run === null) {
    return scenario;
  }
  action(snapshot, `wrapup-input:${run.id}:correction`, 'prepare_input', null, [
    '## Files does not list changed path src/lib/server/read.ts.',
    'Wrap-up changed product code: src/routes/+page.svelte. Route code changes back through work and review.',
  ]);
  return scenario;
}

export function wrapupQuestion(): Scenario {
  const { snapshot } = wrapupRunning();
  const asked = snapshot.runs.at(-1) ?? null;
  if (asked !== null) {
    asked.status = 'terminal';
    asked.terminalKind = 'caller_ping';
  }
  const question = 'The PR template asks for a migration note. Is a schema v2 note enough?';
  pause(snapshot, { code: 'agent_question', question, runId: asked, waiting: true });
  return { question, run: asked, snapshot };
}

export function completed(): Scenario {
  const scenario = handoffReady();
  scenario.snapshot.execution.stage = 'done';
  scenario.snapshot.execution.status = 'complete';
  for (const attention of scenario.snapshot.attention) {
    attention.status = 'resolved';
  }
  return scenario;
}
