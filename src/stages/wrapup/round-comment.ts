import type { Communication } from '../../communication.ts';
import type { FeedbackRoundItem, ReviewVerification } from '../../domain.ts';

// The comment a feedback round leaves on the pull request once its wrap-up
// passes (ADR-004): its commit, and review's verdict on each item. The factory
// writes it from data it already checked; no agent writes it. The wording is
// fixed per voice; tone reaches it only through review's reasons.
//
//   minimal, standard  one line per item: addressed, or left as is: <reason>
//   full               + review's evidence for each item, and the files changed

function itemLabel(item: FeedbackRoundItem): string {
  const who = item.kind === 'note' ? 'note' : item.author;
  const where = item.location === null ? '' : ` on ${item.location}`;
  const label = `${item.id} (${who}${where})`;
  return item.url === null ? label : `[${label}](${item.url})`;
}

export function roundComment(input: {
  communication: Pick<Communication, 'verbosity' | 'voice'>;
  // The round's files, from its start to its commit.
  files: Array<string>;
  // The pull request's head after the round's push.
  head: string;
  items: Array<FeedbackRoundItem>;
  pullRequestUrl: string;
  round: number;
  // Review's Verification lines for the round's task: AC<n> is item F<n>.
  verification: Array<ReviewVerification>;
}): string {
  const { communication, round } = input;
  const full = communication.verbosity === 'full';
  const commit = `[${input.head.slice(0, 7)}](${input.pullRequestUrl}/commits/${input.head})`;
  const opening =
    communication.voice === 'factory'
      ? `The factory finished feedback round ${round} in ${commit}.`
      : `Feedback round ${round}, in ${commit}.`;
  const lines = input.items.map((item, index) => {
    const line = input.verification.find((entry) => entry.id === `AC${index + 1}`);
    if (line === undefined) {
      return `- ${itemLabel(item)}: left as is: review gave no verdict`;
    }
    if (line.status === 'not_verified') {
      return `- ${itemLabel(item)}: left as is: ${line.evidence}`;
    }
    return full
      ? `- ${itemLabel(item)}: addressed — ${line.evidence}`
      : `- ${itemLabel(item)}: addressed`;
  });
  const files =
    full && input.files.length > 0
      ? ['', 'Files changed:', ...input.files.map((file) => `- \`${file}\``)]
      : [];
  return [opening, '', ...lines, ...files].join('\n');
}
