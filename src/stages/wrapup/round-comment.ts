import type { Communication } from '../../communication.ts';
import type { FeedbackRoundItem, ReviewVerification } from '../../domain.ts';

// The comment a feedback round leaves on the pull request once its wrap-up
// passes (ADR-004): its commit, and review's verdict on each item. The factory
// writes it from data it already checked; no agent writes it. The wording is
// fixed per voice; tone reaches it only through review's reasons.
//
//   minimal, standard  one line per item: addressed, or left as is: <reason>
//   full               + review's evidence for each item, and the files changed

export type RoundCommit = { kind: 'none' } | { kind: 'pushed'; sha: string };

function openingLine(input: {
  commit: RoundCommit;
  pullRequestUrl: string;
  round: number;
  voice: Communication['voice'];
}): string {
  const { commit, round } = input;
  switch (commit.kind) {
    case 'none':
      return input.voice === 'factory'
        ? `The factory finished feedback round ${round} without a new commit.`
        : `Feedback round ${round}, with no new commit.`;
    case 'pushed': {
      const link = `[${commit.sha.slice(0, 7)}](${input.pullRequestUrl}/commits/${commit.sha})`;
      return input.voice === 'factory'
        ? `The factory finished feedback round ${round} in ${link}.`
        : `Feedback round ${round}, in ${link}.`;
    }
    default: {
      const _exhaustive: never = commit;
      return _exhaustive;
    }
  }
}

function itemLabel(item: FeedbackRoundItem): string {
  const who = item.kind === 'note' ? 'note' : item.author;
  const where = item.location === null ? '' : ` on ${item.location}`;
  const label = `${item.id} (${who}${where})`;
  return item.url === null ? label : `[${label}](${item.url})`;
}

export function roundComment(input: {
  // The round's commit on the pull request, or none when every item was left
  // as is and there was nothing to commit.
  commit: RoundCommit;
  communication: Pick<Communication, 'verbosity' | 'voice'>;
  // The round's files, from its start to its commit.
  files: Array<string>;
  items: Array<FeedbackRoundItem>;
  pullRequestUrl: string;
  round: number;
  // Review's Verification lines for the round's task: AC<n> is item F<n>.
  verification: Array<ReviewVerification>;
}): string {
  const { communication, round } = input;
  const full = communication.verbosity === 'full';
  const opening = openingLine({
    commit: input.commit,
    pullRequestUrl: input.pullRequestUrl,
    round,
    voice: communication.voice,
  });
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
