import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ticketProgress } from '../controller/progress.ts';
import { clipTaskTitle, taskProgressText } from '../runtime/policy.ts';
import { approvedNext, diffKeepsChanging } from '../stories/scenarios.ts';
import { renderFactoryAgents, type AgentsViewTheme } from './agents-view.ts';
import {
  progressBar,
  renderFactoryWidget,
  ticketLines,
  withCommands,
  type AgentTheme,
  type WidgetChild,
} from './widget.ts';

const theme: AgentTheme = {
  bold: (text) => text,
  fg: (_tone, text) => text,
};

function child(overrides: Partial<WidgetChild>): WidgetChild {
  return {
    activity: 'reading…',
    context: '67K/200K ctx (33.5%)',
    description: 'Turn derivation layer',
    model: 'opencode-go/qwen3.8-max',
    paneName: '🔎 dpaez/factory-dashboard#3',
    sessionFile: '/tmp/session.jsonl',
    startedAt: '2026-10-06T18:00:00.000Z',
    tasksLeft: null,
    taskTitle: null,
    toolUses: 3,
    ...overrides,
  };
}

test('the parent widget shows at most two children and an overflow hint', () => {
  const now = Date.parse('2026-10-06T18:00:14.200Z');
  const lines = renderFactoryWidget({
    children: [
      child({}),
      child({ paneName: '🛠 dpaez/factory-dashboard#3 01', startedAt: '2026-10-06T18:00:10.000Z' }),
      child({ paneName: 'third' }),
    ],
    frame: 0,
    now,
    theme,
    width: 120,
  });
  assert.equal(lines[0], '● Agents · 3 running · 14.2s');
  assert.match(
    lines[1] ?? '',
    /🔎 dpaez\/factory-dashboard#3 · 3 tool uses · 67K\/200K ctx \(33\.5%\)/,
  );
  assert.match(lines.join('\n'), /Turn derivation layer/);
  assert.match(lines.join('\n'), /reading…/);
  assert.doesNotMatch(lines.join('\n'), /third/);
  assert.match(lines.at(-1) ?? '', /\+1 more — \/factory agents/);
  assert.ok(lines.length <= 10);
});

test('the agents overlay is a full-width framed list', () => {
  const theme: AgentsViewTheme = {
    bg: (_color, text) => `SEL:${text}`,
    bold: (text) => text,
    fg: (_tone, text) => text,
  };
  const width = 72;
  const lines = renderFactoryAgents({
    children: [
      child({}),
      child({ description: 'Local diff bug review', paneName: '👀 dpaez/factory-dashboard#3' }),
    ],
    height: 16,
    now: Date.parse('2026-10-06T18:00:14.200Z'),
    selected: 0,
    theme,
    width,
  });
  assert.equal(lines.length, 16);
  assert.ok(lines[0]?.startsWith('─'));
  assert.match(lines.join('\n'), /Factory agents/);
  assert.match(lines.join('\n'), /SEL:.*🔎 dpaez\/factory-dashboard#3/);
  assert.match(lines.join('\n'), /Local diff bug review/);
  assert.match(lines.join('\n'), /\/tmp\/session\.jsonl/);
  assert.match(lines.at(-2) ?? '', /q close/);
  for (const line of lines) {
    assert.ok(line.length >= width);
  }
});

test('work and review rows show the clipped task and how many are left', () => {
  const title = 'Implement /tickets route and the list filters';
  const progress = taskProgressText(title, 3);
  assert.equal(clipTaskTitle(title).length, 40);
  assert.equal(progress, `${clipTaskTitle(title)} · 3 left`);
  assert.ok(progress.length <= 80);
  const lines = renderFactoryWidget({
    children: [
      child({
        description: 'Turn derivation layer',
        paneName: '🛠 dpaez/factory-dashboard#3 01',
        tasksLeft: 3,
        taskTitle: title,
      }),
    ],
    frame: 0,
    now: Date.parse('2026-10-06T18:00:14.200Z'),
    theme,
    width: 160,
  });
  assert.match(lines.join('\n'), /Implement \/tickets route and the list f… · 3 left/);
  assert.doesNotMatch(lines.join('\n'), /Turn derivation layer/);
  const overlay = renderFactoryAgents({
    children: [
      child({
        description: 'Local diff bug review',
        paneName: '👀 dpaez/factory-dashboard#3',
        tasksLeft: 1,
        taskTitle: title,
      }),
    ],
    height: 12,
    now: Date.parse('2026-10-06T18:00:14.200Z'),
    selected: 0,
    theme: {
      bg: (_color, text) => text,
      bold: (text) => text,
      fg: (_tone, text) => text,
    },
    width: 120,
  });
  assert.match(overlay.join('\n'), /Implement \/tickets route and the list f… · 1 left/);
  assert.doesNotMatch(overlay.join('\n'), /Local diff bug review/);
});

test('ticket progress stays on screen when no child is running', () => {
  const { snapshot } = approvedNext();
  const lines = renderFactoryWidget({
    children: [],
    frame: 0,
    now: 0,
    theme,
    tickets: [ticketProgress(snapshot)],
    width: 80,
  });
  assert.deepEqual(lines, [
    '● dpaez/factory-dashboard#11 · ■■■□□□ 3/6 · work',
    '  04/06 Ticket detail page (`/tickets/[slug]`) on the v2 read module',
  ]);
  assert.equal(progressBar(3, 6), '■■■□□□');
  assert.equal(progressBar(5, 20), '■■■□□□□□□□');
});

test('a ticket waiting on the user shows the command to run', () => {
  const { snapshot } = diffKeepsChanging();
  const lines = ticketLines(ticketProgress(snapshot), theme);
  assert.equal(lines[0], '▲ dpaez/factory-dashboard#11 · ■■□□□□ 2/6 · review r1');
  assert.equal(lines[2], '  paused · → /factory retry dpaez/factory-dashboard#11');
});

// A ticket's controller step, running or queued.
function stepFor(state: 'queued' | 'running') {
  return {
    displayRef: 'proj-1',
    step: {
      command: null,
      kind: 'validate_run' as const,
      label: "validating task 02's work",
      since: '2026-10-09T14:59:19.000Z',
      state,
    },
    ticket: 'proj-1-abc',
  };
}

test('a controller step shows under its ticket: running with a spinner and its time, queued dimmed', () => {
  const ticket = {
    current: null,
    displayRef: 'proj-1',
    done: 1,
    needsUser: false,
    next: null,
    stage: 'work' as const,
    status: 'active',
    total: 3,
  };
  const render = (state: 'queued' | 'running') =>
    renderFactoryWidget({
      children: [],
      frame: 0,
      now: Date.parse('2026-10-09T15:00:00.000Z'),
      steps: [stepFor(state)],
      theme,
      tickets: [ticket],
      width: 80,
    });
  assert.deepEqual(render('running').slice(1), ["  ◜ validating task 02's work · 41.0s"]);
  assert.deepEqual(render('queued').slice(1), ["  ◌ queued: validating task 02's work"]);
});

test('a running step shows the command it is on, and its position', () => {
  const step = {
    ...stepFor('running'),
    step: {
      ...stepFor('running').step,
      command: { command: 'test', index: 2, startedAt: '2026-10-09T14:59:50.000Z', total: 3 },
    },
  };
  const lines = renderFactoryWidget({
    children: [],
    frame: 0,
    now: Date.parse('2026-10-09T15:00:00.000Z'),
    steps: [step],
    theme,
    tickets: [
      {
        current: null,
        displayRef: 'proj-1',
        done: 1,
        needsUser: false,
        next: null,
        stage: 'work',
        status: 'active',
        total: 3,
      },
    ],
    width: 80,
  });
  assert.deepEqual(lines.slice(1), ["  ◜ validating task 02's work · test (2/3) · 41.0s"]);
});

test('the server’s command is shown only on the step it belongs to', () => {
  const command = { command: 'test', index: 2, startedAt: 't', total: 3 };
  const current = [stepFor('running')];
  const live = (since: string) =>
    new Map([['proj-1-abc', { command, kind: 'validate_run', since }]]);
  assert.deepEqual(
    withCommands(current, live('2026-10-09T14:59:19.000Z'))[0]?.step.command,
    command,
  );
  // A command from an earlier step of the ticket is not this one's.
  assert.equal(withCommands(current, live('2026-10-09T14:00:00.000Z'))[0]?.step.command, null);
  assert.equal(withCommands(current, new Map())[0]?.step.command, null);
});
