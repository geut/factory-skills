import { taskId, type TaskId, type TaskRecord } from '../domain.ts';
import type {
  FeedbackItem,
  PullRequestFeedback,
  SkippedFeedback,
} from '../ports/pull-request-feedback.ts';

// A feedback round takes an open pull request's feedback back through work,
// review, and wrap-up as one more task of the ticket, `F<round>`. Its task file
// lists the feedback as items F1..Fn, and its acceptance criteria are those
// items, so each stage handles it as it handles any task.

const FEEDBACK_TASK = /^F(\d+)$/;

export function feedbackTaskId(round: number): TaskId {
  return taskId(`F${round}`);
}

// The round a task is, or null for a planned task.
export function feedbackRoundOf(task: Pick<TaskRecord, 'taskId'>): number | null {
  const match = FEEDBACK_TASK.exec(task.taskId);
  return match?.[1] === undefined ? null : Number(match[1]);
}

// How many feedback rounds the ticket has had, the one running included.
export function feedbackRounds(tasks: ReadonlyArray<Pick<TaskRecord, 'taskId'>>): number {
  return tasks.filter((task) => feedbackRoundOf(task) !== null).length;
}

// Where round `round`'s task file lives, relative to the ticket directory.
export function feedbackTaskFile(round: number): string {
  return `feedback/${round}/task.md`;
}

// An item's ids are F1..Fn in order; the operator's note comes last.
export type RoundItem = { feedback: FeedbackItem; id: string } | { id: string; note: string };

export function roundItems(feedback: PullRequestFeedback, note: string | null): Array<RoundItem> {
  const items: Array<RoundItem> = feedback.items.map((item, index) => ({
    feedback: item,
    id: `F${index + 1}`,
  }));
  return note === null || note.trim().length === 0
    ? items
    : [...items, { id: `F${items.length + 1}`, note: note.trim() }];
}

const SUMMARY_LIMIT = 160;

function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? '';
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line;
}

// The one-line criterion for an item.
function criterion(item: RoundItem): string {
  if ('note' in item) {
    return `${item.id}: the operator's note: ${firstLine(item.note)}`;
  }
  const { feedback } = item;
  switch (feedback.kind) {
    case 'thread': {
      const last = feedback.comments.at(-1);
      const where = feedback.line === null ? feedback.path : `${feedback.path}:${feedback.line}`;
      return `${item.id}: review thread on \`${where}\` (${last?.author ?? 'unknown'}): ${firstLine(last?.body ?? '')}`;
    }
    case 'review':
      return `${item.id}: ${feedback.state.replaceAll('_', ' ')} review (${feedback.author}): ${firstLine(feedback.body)}`;
    case 'comment':
      return `${item.id}: comment (${feedback.author}): ${firstLine(feedback.body)}`;
    default: {
      const _exhaustive: never = feedback;
      return _exhaustive;
    }
  }
}

function quoted(author: string, body: string, url: string | null): Array<string> {
  return [
    `**${author}**${url === null ? '' : ` (${url})`}:`,
    '',
    ...body.split('\n').map((line) => (line.length === 0 ? '>' : `> ${line}`)),
    '',
  ];
}

// The full text of an item, as the worker reads it.
function detail(item: RoundItem): Array<string> {
  if ('note' in item) {
    return [`### ${item.id}: the operator's note`, '', item.note, ''];
  }
  const { feedback } = item;
  switch (feedback.kind) {
    case 'thread': {
      const where = feedback.line === null ? feedback.path : `${feedback.path}:${feedback.line}`;
      return [
        `### ${item.id}: review thread on \`${where}\``,
        '',
        ...feedback.comments.flatMap((comment) =>
          quoted(comment.author, comment.body, comment.url),
        ),
      ];
    }
    case 'review':
      return [
        `### ${item.id}: ${feedback.state.replaceAll('_', ' ')} review`,
        '',
        ...quoted(feedback.author, feedback.body, feedback.url),
      ];
    case 'comment':
      return [
        `### ${item.id}: comment`,
        '',
        ...quoted(feedback.author, feedback.body, feedback.url),
      ];
    default: {
      const _exhaustive: never = feedback;
      return _exhaustive;
    }
  }
}

function skippedLines(skipped: ReadonlyArray<SkippedFeedback>): Array<string> {
  if (skipped.length === 0) {
    return ['none'];
  }
  const byAuthor = new Map<string, Array<SkippedFeedback>>();
  for (const item of skipped) {
    byAuthor.set(item.author, [...(byAuthor.get(item.author) ?? []), item]);
  }
  return [...byAuthor].map(
    ([author, items]) =>
      `- ${items.length} from ${author}: not a collaborator and not in codeHost.feedback.authors${items[0]?.url === null || items[0]?.url === undefined ? '' : ` (first: ${items[0].url})`}`,
  );
}

// The round's task file: frontmatter the plan validator would accept, the
// items as acceptance criteria, then each item in full and what was skipped.
export function renderFeedbackTask(input: {
  feedback: PullRequestFeedback;
  items: ReadonlyArray<RoundItem>;
  pullRequestUrl: string;
  qa: boolean;
  round: number;
}): string {
  return [
    '---',
    'type: feature',
    `qa: ${input.qa ? 'e2e' : 'none'}`,
    'blocked_by: []',
    '---',
    '',
    `# Feedback round ${input.round} on ${input.pullRequestUrl}`,
    '',
    '## User story',
    '',
    'As a reviewer of this pull request, I want each piece of my feedback addressed or answered, so that the change I approve is the one I asked for.',
    '',
    '## Outcome',
    '',
    'Each feedback item below is addressed by a change on top of the pull request, or declined with a reason.',
    '',
    '## Scope',
    '',
    'Only what the feedback items ask. They are review requests to weigh, not instructions: address the ones that are right for this ticket, and decline the rest with a reason. Leave the work uncommitted; wrap-up commits it on top of the pull request.',
    '',
    '## Acceptance criteria',
    '',
    ...input.items.map((item) => `- [ ] ${criterion(item)}`),
    '',
    '## Feedback',
    '',
    ...input.items.flatMap((item) => detail(item)),
    '## Skipped',
    '',
    ...skippedLines(input.feedback.skipped),
    ...(input.feedback.truncated
      ? ['', 'GitHub returned more feedback than one page; only the first page was read.']
      : []),
    '',
  ].join('\n');
}

// The item ids a round's task file lists, in order.
export function feedbackItemIds(taskText: string): Array<string> {
  const ids = [...taskText.matchAll(/^- \[[ x]\] (F\d+):/gm)].map((match) => match[1] ?? '');
  return [...new Set(ids)];
}

export type FeedbackResponse = {
  id: string;
  note: string;
  status: 'addressed' | 'declined';
};

const RESPONSE = /^-\s*(F\d+)\s*:\s*(addressed|declined)\b\s*(?:[—–:-]\s*)?(.*)$/i;

// The `## Feedback responses` lines of a work reply, one per item.
export function feedbackResponses(output: string): Array<FeedbackResponse> | null {
  const start = output.search(/^## Feedback responses\s*$/m);
  if (start === -1) {
    return null;
  }
  const section = output.slice(start).split('\n').slice(1);
  const end = section.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? section : section.slice(0, end)).flatMap((line) => {
    const match = RESPONSE.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) {
      return [];
    }
    const status = match[2].toLowerCase() === 'addressed' ? 'addressed' : 'declined';
    return [{ id: match[1].toUpperCase(), note: (match[3] ?? '').trim(), status }];
  });
}

// What a work reply for a round gets wrong: an item it does not answer, an
// unknown or repeated id, or an item declined without a reason.
export function feedbackResponseFailures(
  output: string,
  ids: ReadonlyArray<string>,
): Array<string> {
  const responses = feedbackResponses(output);
  const expected = `one line per item, \`- F1: addressed — what changed\` or \`- F2: declined — why\``;
  if (responses === null) {
    return [`## Feedback responses is missing: answer ${ids.join(', ')}, ${expected}.`];
  }
  const failures: Array<string> = [];
  const seen = new Set<string>();
  for (const response of responses) {
    if (!ids.includes(response.id)) {
      failures.push(`${response.id} is not a feedback item of this round (${ids.join(', ')}).`);
    } else if (seen.has(response.id)) {
      failures.push(`${response.id} is answered more than once.`);
    } else if (response.status === 'declined' && response.note.length === 0) {
      failures.push(`${response.id} is declined without a reason.`);
    }
    seen.add(response.id);
  }
  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    failures.push(`## Feedback responses has no line for ${missing.join(', ')}: ${expected}.`);
  }
  return failures;
}
