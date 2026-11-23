import { readWorkReport, renderWorkReport } from './work-report.ts';

export type SessionActivity = {
  activity: string;
  contextTokens: number;
  lastText: string;
  model: string | null;
  provider: string | null;
  toolUses: number;
};

const toolVerbs: Record<string, string> = {
  bash: 'running command',
  edit: 'editing',
  find: 'finding files',
  grep: 'searching',
  ls: 'listing',
  read: 'reading',
  write: 'writing',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(message: Record<string, unknown>): string {
  const content = message['content'];
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: Array<string> = [];
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') {
      continue;
    }
    const text = block['text'].trim();
    if (text.length > 0) {
      parts.push(text);
    }
  }
  return parts.join('\n');
}

function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function collapse(action: string, count: number): string {
  if (count <= 1) {
    return `${action}…`;
  }
  if (action === 'running command') {
    return `running ${count} commands…`;
  }
  if (action === 'searching') {
    return `searching ${count} patterns…`;
  }
  return `${action} ${count} files…`;
}

function describeActivity(toolNames: Array<string>, responseText: string): string {
  if (toolNames.length > 0) {
    const groups = new Map<string, number>();
    for (const toolName of toolNames) {
      const action = toolVerbs[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }
    return [...groups.entries()].map(([action, count]) => collapse(action, count)).join(', ');
  }
  const preview = firstLine(responseText);
  return preview.length > 0 ? preview : 'thinking…';
}

export function sessionActivity(jsonl: string): SessionActivity {
  const entries: Array<Record<string, unknown>> = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) {
        entries.push(parsed);
      }
    } catch {
      break;
    }
  }
  let toolUses = 0;
  let lastAssistant: Record<string, unknown> | null = null;
  let lastAssistantIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry['type'] !== 'message' || !isRecord(entry['message'])) {
      continue;
    }
    const message = entry['message'];
    if (message['role'] === 'toolResult') {
      toolUses += 1;
      continue;
    }
    if (message['role'] === 'assistant') {
      lastAssistant = message;
      lastAssistantIndex = index;
    }
  }
  const pending = new Map<string, string>();
  if (lastAssistant !== null && lastAssistantIndex >= 0) {
    const content = lastAssistant['content'];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block) || block['type'] !== 'toolCall' || typeof block['id'] !== 'string') {
          continue;
        }
        pending.set(block['id'], typeof block['name'] === 'string' ? block['name'] : 'tool');
      }
    }
    for (let index = lastAssistantIndex + 1; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined || entry['type'] !== 'message' || !isRecord(entry['message'])) {
        continue;
      }
      const message = entry['message'];
      if (message['role'] === 'toolResult' && typeof message['toolCallId'] === 'string') {
        pending.delete(message['toolCallId']);
      }
    }
  }
  const lastText = lastAssistant === null ? '' : textOf(lastAssistant);
  const usage =
    lastAssistant !== null && isRecord(lastAssistant['usage']) ? lastAssistant['usage'] : null;
  const contextTokens = usage === null ? 0 : numberField(usage, 'totalTokens');
  return {
    activity: describeActivity([...pending.values()], lastText),
    contextTokens,
    lastText,
    model:
      lastAssistant !== null && typeof lastAssistant['model'] === 'string'
        ? lastAssistant['model']
        : null,
    provider:
      lastAssistant !== null && typeof lastAssistant['provider'] === 'string'
        ? lastAssistant['provider']
        : null,
    toolUses,
  };
}

export function lastAssistantText(jsonl: string): string {
  return sessionActivity(jsonl).lastText;
}

// The session lines of one run: from its prompt to the next run's, or null
// when the session has no prompt of the run.
function runLines(jsonl: string, runId: string): Array<string> | null {
  const marker = `Factory run ${runId}`;
  const lines = jsonl.split('\n');
  const start = lines.findIndex((line) => line.includes(marker));
  if (start < 0) {
    return null;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.includes('Factory run ') && !line.includes(marker)) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

// The report a run's accepted subagent_done call carried, rendered as the
// work template; null when the run ended without one, as every stage without
// a report does. A refused call's result is an error, so its arguments never
// count.
export function runReport(jsonl: string, runId: string): string | null {
  const lines = runLines(jsonl, runId);
  if (lines === null) {
    return null;
  }
  const calls = new Map<string, unknown>();
  let accepted: unknown = null;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const message = isRecord(parsed) && isRecord(parsed['message']) ? parsed['message'] : null;
    if (message === null) {
      continue;
    }
    if (message['role'] === 'assistant' && Array.isArray(message['content'])) {
      for (const block of message['content']) {
        if (
          isRecord(block) &&
          block['type'] === 'toolCall' &&
          block['name'] === 'subagent_done' &&
          typeof block['id'] === 'string'
        ) {
          calls.set(block['id'], block['arguments']);
        }
      }
    }
    const id = message['toolCallId'];
    if (
      message['role'] === 'toolResult' &&
      message['isError'] !== true &&
      typeof id === 'string' &&
      calls.has(id)
    ) {
      accepted = calls.get(id);
    }
  }
  const report = readWorkReport(accepted);
  return report === null ? null : renderWorkReport(report);
}

export function runAssistantText(jsonl: string, runId: string): string {
  const report = runReport(jsonl, runId);
  if (report !== null) {
    return report;
  }
  const lines = runLines(jsonl, runId);
  if (lines === null) {
    return lastAssistantText(jsonl);
  }
  const text = lastAssistantText(lines.join('\n'));
  return text.length > 0 ? text : lastAssistantText(jsonl);
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function formatCompactCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return `${count}`;
}

export function childReplyExcerpt(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 6);
  if (lines.length === 0) {
    return null;
  }
  return lines.map((line) => (line.length > 120 ? `${line.slice(0, 119)}…` : line)).join('\n');
}

export function contextLabel(tokens: number, contextWindow: number | null): string | null {
  if (tokens <= 0) {
    return null;
  }
  if (contextWindow === null || contextWindow <= 0) {
    return `${formatCompactCount(tokens)} tokens`;
  }
  const pct = Math.min((tokens / contextWindow) * 100, 100);
  return `${formatCompactCount(tokens)}/${formatCompactCount(contextWindow)} ctx (${pct.toFixed(1)}%)`;
}
