import { readFileSync, statSync } from 'node:fs';
import { truncateToWidth } from '@earendil-works/pi-tui';
import type { RunningChildRow } from '../controller/store.ts';
import { taskProgressText } from '../runtime/policy.ts';
import { sessionActivity, type SessionActivity } from '../runtime/session-activity.ts';

export type AgentTheme = {
  bold: (text: string) => string;
  fg: (tone: 'accent' | 'dim' | 'muted', text: string) => string;
};

export type WidgetChild = RunningChildRow & {
  activity: string;
  context: string | null;
  toolUses: number;
};

const spinnerFrames = ['◜', '◠', '◝', '◞', '◡', '◟'];
const maxLines = 10;

const sessionCache = new Map<string, { activity: SessionActivity; size: number }>();

export function readChildActivity(sessionFile: string | null): SessionActivity {
  const empty: SessionActivity = {
    activity: 'starting…',
    contextTokens: 0,
    lastText: '',
    model: null,
    provider: null,
    toolUses: 0,
  };
  if (sessionFile === null) {
    return empty;
  }
  try {
    const size = statSync(sessionFile).size;
    const cached = sessionCache.get(sessionFile);
    if (cached !== undefined && cached.size === size) {
      return cached.activity;
    }
    const activity = sessionActivity(readFileSync(sessionFile, 'utf8'));
    sessionCache.set(sessionFile, { activity, size });
    return activity;
  } catch {
    return empty;
  }
}

export function childProgress(child: Pick<WidgetChild, 'taskTitle' | 'tasksLeft'>): string | null {
  if (child.taskTitle === null || child.taskTitle.trim().length === 0 || child.tasksLeft === null) {
    return null;
  }
  return taskProgressText(child.taskTitle, child.tasksLeft);
}

export function formatElapsed(startedAt: string | null, now: number): string {
  if (startedAt === null) {
    return '0.0s';
  }
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) {
    return '0.0s';
  }
  return `${Math.max(0, (now - start) / 1000).toFixed(1)}s`;
}

export function renderFactoryWidget(input: {
  children: Array<WidgetChild>;
  frame: number;
  now: number;
  theme: AgentTheme;
  width: number;
}): Array<string> {
  const { children, theme } = input;
  if (children.length === 0) {
    return [];
  }
  const visible = children.slice(0, 2);
  const hidden = children.length - visible.length;
  const oldest = children.reduce((min, child) => {
    const start = child.startedAt === null ? input.now : Date.parse(child.startedAt);
    return Number.isNaN(start) ? min : Math.min(min, start);
  }, input.now);
  const spinner = spinnerFrames[input.frame % spinnerFrames.length] ?? '●';
  const lines = [
    `${theme.fg('accent', '●')} ${theme.fg('accent', 'Agents')}${theme.fg('dim', ` · ${children.length} running · ${formatElapsed(new Date(oldest).toISOString(), input.now)}`)}`,
  ];
  for (let index = 0; index < visible.length; index += 1) {
    const child = visible[index];
    if (child === undefined) {
      continue;
    }
    const last = index === visible.length - 1 && hidden === 0;
    const connector = last ? '└─' : '├─';
    const childConnector = last ? '   ' : '│  ';
    const progress = childProgress(child);
    const stats: Array<string> = [];
    if (child.toolUses > 0) {
      stats.push(`${child.toolUses} tool use${child.toolUses === 1 ? '' : 's'}`);
    }
    if (child.context !== null) {
      stats.push(child.context);
    }
    if (progress !== null) {
      stats.push(progress);
    }
    const statsText =
      stats.length > 0 ? ` ${theme.fg('dim', '·')} ${theme.fg('dim', stats.join(' · '))}` : '';
    lines.push(
      `${theme.fg('dim', connector)} ${theme.fg('accent', spinner)} ${theme.bold(child.paneName ?? 'factory')}${statsText}`,
    );
    if (progress === null && child.description !== null) {
      lines.push(
        `${theme.fg('dim', childConnector)}${theme.fg('muted', `  ${child.description}`)}`,
      );
    }
    lines.push(`${theme.fg('dim', childConnector)}${theme.fg('dim', `  ${child.activity}`)}`);
  }
  if (hidden > 0) {
    lines.push(theme.fg('muted', `... (+${hidden} more — /factory agents)`));
  }
  return lines
    .slice(0, maxLines)
    .map((line) => truncateToWidth(line, Math.max(1, input.width - 4)));
}
