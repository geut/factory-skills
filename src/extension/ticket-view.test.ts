import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TicketDetail } from '../controller/view.ts';
import { runId } from '../domain.ts';
import type { AgentsViewTheme } from './agents-view.ts';
import { renderTicketDetail } from './ticket-view.ts';

const theme: AgentsViewTheme = {
  bg: (_color, text) => text,
  bold: (text) => text,
  fg: (_color, text) => text,
};

test('the ticket view lists runs and shows the selected message', () => {
  const detail: TicketDetail = {
    displayRef: 'proj-123',
    progress: null,
    runs: [
      {
        label: 'plan · planned',
        outcome: 'planned',
        runId: runId('run-1'),
        sessionFile: null,
      },
      {
        label: 'work · 01 · correction · correcting',
        outcome: 'correcting',
        runId: runId('run-2'),
        sessionFile: null,
      },
    ],
  };
  const lines = renderTicketDetail({
    detail,
    height: 16,
    message: 'diff is empty\nThe files were not changed.',
    scroll: 0,
    selected: 1,
    theme,
    width: 60,
  });
  const text = lines.join('\n');
  assert.match(text, /proj-123/);
  assert.match(text, /plan · planned/);
  assert.match(text, /work · 01 · correction · correcting/);
  assert.match(text, /diff is empty/);
  assert.match(text, /The files were not changed/);
});
