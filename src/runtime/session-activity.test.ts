import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  childReplyExcerpt,
  contextLabel,
  lastAssistantText,
  runAssistantText,
  sessionActivity,
} from './session-activity.ts';

test('session activity reports pending tools, tokens, and the last assistant text', () => {
  const jsonl = [
    JSON.stringify({
      message: {
        content: [{ text: 'older', type: 'text' }],
        role: 'assistant',
        usage: { totalTokens: 10 },
      },
      type: 'message',
    }),
    JSON.stringify({
      message: {
        content: [
          { text: '## Status\nplanned', type: 'text' },
          { id: 'a', name: 'read', type: 'toolCall' },
          { id: 'b', name: 'read', type: 'toolCall' },
        ],
        model: 'qwen3.8-max',
        provider: 'opencode-go',
        role: 'assistant',
        usage: { totalTokens: 67_000 },
      },
      type: 'message',
    }),
    JSON.stringify({ message: { role: 'toolResult', toolCallId: 'a' }, type: 'message' }),
  ].join('\n');
  const activity = sessionActivity(jsonl);
  assert.equal(activity.activity, 'reading…');
  assert.equal(activity.toolUses, 1);
  assert.equal(activity.contextTokens, 67_000);
  assert.equal(activity.provider, 'opencode-go');
  assert.equal(lastAssistantText(jsonl), '## Status\nplanned');
  assert.equal(contextLabel(67_000, 200_000), '67K/200K ctx (33.5%)');
  assert.equal(contextLabel(67_000, null), '67K tokens');
  assert.equal(
    childReplyExcerpt('## Status\nplanned\n\nTasks are ready.'),
    '## Status\nplanned\nTasks are ready.',
  );
});

test('a run message is the assistant text after that run marker', () => {
  const jsonl = [
    JSON.stringify({
      message: { content: 'Factory run run-1', role: 'user' },
      type: 'message',
    }),
    JSON.stringify({
      message: { content: [{ text: 'Plan is ready.', type: 'text' }], role: 'assistant' },
      type: 'message',
    }),
    JSON.stringify({
      message: { content: 'Factory run run-2', role: 'user' },
      type: 'message',
    }),
    JSON.stringify({
      message: { content: [{ text: 'Checks still fail.', type: 'text' }], role: 'assistant' },
      type: 'message',
    }),
  ].join('\n');
  assert.equal(runAssistantText(jsonl, 'run-1'), 'Plan is ready.');
  assert.equal(runAssistantText(jsonl, 'run-2'), 'Checks still fail.');
  assert.equal(runAssistantText(jsonl, 'missing'), 'Checks still fail.');
});
