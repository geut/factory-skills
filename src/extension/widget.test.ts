import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderFactoryAgents, type AgentsViewTheme } from './agents-view.ts';
import { renderFactoryWidget, type AgentTheme, type WidgetChild } from './widget.ts';

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
