import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TicketDetail } from '../controller/service.ts';
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
    runs: [
      {
        label: 'plan · done',
        outcome: 'done',
        runId: runId('run-1'),
        sessionFile: null,
      },
      {
        label: 'work · correction 1 · checks failed',
        outcome: 'checks failed',
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
  assert.match(text, /plan · done/);
  assert.match(text, /work · correction 1 · checks failed/);
  assert.match(text, /diff is empty/);
  assert.match(text, /The files were not changed/);
});
