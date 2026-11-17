import type { Communication } from '../communication.ts';
import type { IssueChecklist } from '../stages/wrapup/checklist.ts';

// What the factory comments on a ticket's issue, by the ticket's verbosity and
// voice (ADR-004). Null leaves the comment out at that level. The wording is
// fixed per voice: tone only steers text an agent writes.
//
//                              minimal  standard              full
//   started, round, cancelled  no       no                    yes
//   handoff                    no       PR link, left open    + decisions, rule changes
//   checklist ticks            no       yes                   yes
//   pause question             yes      yes                   yes

type Settings = Pick<Communication, 'verbosity' | 'voice'>;

export function startedComment({ verbosity, voice }: Settings): string | null {
  if (verbosity !== 'full') {
    return null;
  }
  return voice === 'factory'
    ? 'The factory started working on this issue.'
    : 'Started working on this.';
}

export function feedbackRoundComment({ verbosity, voice }: Settings, round: number): string | null {
  if (verbosity !== 'full') {
    return null;
  }
  return voice === 'factory'
    ? `The factory started feedback round ${round} on the pull request.`
    : `Working on the review feedback (round ${round}).`;
}

export function cancelledComment(
  { verbosity, voice }: Settings,
  input: { by: string | null; reason: string | null },
): string | null {
  if (verbosity !== 'full') {
    return null;
  }
  const by = input.by === null ? '' : ` by ${input.by}`;
  return [
    voice === 'factory'
      ? `The factory stopped working on this issue: cancelled${by}.`
      : `Stopped working on this: cancelled${by}.`,
    ...(input.reason === null ? [] : ['', `> ${input.reason}`]),
  ].join('\n');
}

// A pause blocks the ticket on a person, so it is posted at every level. In
// the developer voice it asks as the owner would, without the factory's
// commands.
export function pausedComment(
  { voice }: Settings,
  input: { commandRef: string; question: string },
): string {
  const quoted = input.question
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return voice === 'factory'
    ? [
        'The factory paused this ticket and needs a person:',
        '',
        quoted,
        '',
        `Answer from the dashboard, or in Pi with \`/factory reply ${input.commandRef} "answer"\`.`,
      ].join('\n')
    : ['Blocked, need input:', '', quoted].join('\n');
}

export function handoffComment(
  { verbosity, voice }: Settings,
  input: {
    checklist: IssueChecklist | null;
    pullRequestUrl: string | null;
    // Project rule files the ticket changes.
    rules: Array<string>;
  },
): string | null {
  if (verbosity === 'minimal') {
    return null;
  }
  const { checklist, pullRequestUrl, rules } = input;
  const opening =
    voice === 'factory'
      ? pullRequestUrl === null
        ? 'The factory finished this ticket. Its handoff has the merge commands.'
        : `The factory finished this ticket and opened ${pullRequestUrl} for review.`
      : pullRequestUrl === null
        ? 'Done, ready to merge.'
        : `Done, ready for review: ${pullRequestUrl}`;
  const open =
    checklist === null || checklist.open.length === 0
      ? []
      : ['', 'Left open:', ...checklist.open.map((box) => `- [ ] ${box.text} — ${box.reason}`)];
  if (verbosity === 'standard') {
    return [opening, ...open].join('\n');
  }
  const ruleChanges = rules.length === 0 ? [] : ['', ruleChangesLine(voice, rules)];
  const decisions =
    checklist === null || checklist.decisions.length === 0
      ? []
      : ['', 'Decisions:', ...checklist.decisions.map((decision) => `- ${decision}`)];
  return [opening, ...ruleChanges, ...decisions, ...open].join('\n');
}

// The issue's met checklist items to tick at handoff: none at minimal, which
// writes only the pull request.
export function handoffChecklist(
  { verbosity }: Settings,
  checklist: IssueChecklist | null,
): Array<{ key: string; text: string }> {
  return verbosity === 'minimal'
    ? []
    : (checklist?.met.map(({ key, text }) => ({ key, text })) ?? []);
}

// A change to the project's rules is named before anyone merges it: on the
// issue at full, and to the person in Pi at every level.
export function ruleChangesLine(voice: Communication['voice'], rules: Array<string>): string {
  return voice === 'factory'
    ? `This ticket changes project rules: ${rules.join(', ')}. The reviewer judged the work by the base branch's rules and each change by the task's scope; check them before merging.`
    : `This changes project rules: ${rules.join(', ')}. Check them before merging.`;
}
