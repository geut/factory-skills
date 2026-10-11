import type { StageName } from '../domain.ts';
import { stages } from '../stages/index.ts';

export function paneLabel(stage: StageName, displayRef: string, taskId: string | null): string {
  const emoji = stages[stage].emoji;
  if (stage === 'work' && taskId !== null) {
    return `${emoji} ${displayRef} ${taskId}`;
  }
  return `${emoji} ${displayRef}`;
}

const runStatusLabels = {
  human_reply: 'reply',
  infrastructure_retry: 'retry',
  initial: 'initial',
  manual_continue: 'continue',
  reentry: 'rerun',
  return_to_work: 'return',
  validation_correction: 'correction',
} as const;

const taskTitleLimit = 40;
const herdrTokenLimit = 80;

export function runStatusLabel(purpose: keyof typeof runStatusLabels): string {
  return runStatusLabels[purpose];
}

export function clipTaskTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= taskTitleLimit) {
    return trimmed;
  }
  return `${trimmed.slice(0, taskTitleLimit - 1)}…`;
}

export function taskProgressText(title: string, tasksLeft: number): string {
  const suffix = ` · ${tasksLeft} left`;
  const clipped = clipTaskTitle(title);
  const room = herdrTokenLimit - suffix.length;
  const visible = clipped.length <= room ? clipped : `${clipped.slice(0, Math.max(0, room - 1))}…`;
  return `${visible}${suffix}`;
}

export function childDescription(title: string): string {
  const stripped = title
    .replaceAll(/\([^)]*\)/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  const words = stripped
    .split(' ')
    .filter((word) => word.length > 0)
    .slice(0, 8);
  if (words.length === 0) {
    return 'Untitled factory task';
  }
  const phrase = words.join(' ');
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
