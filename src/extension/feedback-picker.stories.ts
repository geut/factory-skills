import type { FeedbackCandidate } from '../stages/feedback.ts';
import { story, type Component } from '../stories/story.ts';
import { renderFeedbackPicker, type FeedbackPickerState } from './feedback-picker.ts';

type Args = FeedbackPickerState & { height: number };

const pullRequestUrl = 'https://github.com/dpaez/factory-dashboard/pull/71';

const reviewers: Array<FeedbackCandidate> = [
  {
    author: 'coderabbitai',
    kind: 'thread',
    location: 'src/lib/factory/ticket-actions.ts:42',
    ref: 'r2841017733',
    summary: 'Consider guarding the action when the pull request is closed.',
    url: `${pullRequestUrl}#discussion_r2841017733`,
  },
  {
    author: 'copilot-pull-request-reviewer',
    kind: 'thread',
    location: 'src/lib/factory/ticket-actions.ts:40',
    ref: 'r2841017790',
    summary:
      'Guard the feedback action on the pull request state and rename `canFeedback` to `feedbackAvailability`, since it returns a reason too; this also covers the closed case above.',
    url: `${pullRequestUrl}#discussion_r2841017790`,
  },
  {
    author: 'dpaez',
    kind: 'comment',
    location: null,
    ref: 'c6799058255',
    summary: 'Make the `feedback round` button disabled if we are not in the wrapup stage.',
    url: `${pullRequestUrl}#issuecomment-6799058255`,
  },
];

// Twelve comments, as a review bot leaves one per finding.
function many(): Array<FeedbackCandidate> {
  return [
    ...reviewers,
    ...Array.from({ length: 9 }, (_, index) => ({
      author: 'coderabbitai',
      kind: 'thread' as const,
      location: `src/lib/factory/board.ts:${20 + index * 7}`,
      ref: `r28410180${String(index).padStart(2, '0')}`,
      summary: `Nitpick ${index + 1}: prefer a named helper over the inline expression here.`,
      url: `${pullRequestUrl}#discussion_r28410180${String(index).padStart(2, '0')}`,
    })),
  ];
}

function base(overrides: Partial<FeedbackPickerState> = {}): Args {
  return {
    candidates: reviewers,
    cursor: 0,
    displayRef: 'dpaez/factory-dashboard#70',
    height: 24,
    message: null,
    note: null,
    pullRequestUrl,
    skipped: 1,
    ticked: reviewers.map((item) => item.ref),
    truncated: false,
    ...overrides,
  };
}

function picker(name: string, description: string, args: () => Args) {
  return story<Args>({
    args,
    description,
    name,
    render: (value, { theme, width }) => renderFeedbackPicker({ ...value, theme, width }),
  });
}

export const component: Component = {
  description:
    'Fullscreen picker for a feedback round (`/factory feedback <ticket> --list`). It lists the pull request’s pending comments in a scrolling window; space ticks the ones to act on, and enter starts a round on them.',
  id: 'feedback-picker',
  name: 'Feedback Picker',
  stories: [
    picker(
      'three pending, all ticked',
      'The picker as it opens: every pending comment ticked, the first selected, its full summary and link below the list.',
      () => base(),
    ),
    picker(
      'one unticked, the long one selected',
      'The operator moved to the second comment and unticked the first: enter starts a round on two, with --only.',
      () => base({ cursor: 1, ticked: ['r2841017790', 'c6799058255'] }),
    ),
    picker(
      'twelve pending, scrolled',
      'More comments than the window: it scrolls with the selection and says which rows it shows.',
      () => {
        const candidates = many();
        return base({
          candidates,
          cursor: 9,
          ticked: candidates.slice(0, 4).map((item) => item.ref),
        });
      },
    ),
    picker(
      'with a note, nothing ticked',
      'The note came with the command and joins the round as its own item. With nothing ticked, enter asks for a tick first.',
      () =>
        base({
          message: 'Tick at least one comment to start a round.',
          note: 'Also mention the button in the README.',
          ticked: [],
        }),
    ),
    picker('nothing pending', 'Every comment was taken by a round or dismissed.', () =>
      base({ candidates: [], skipped: 0, ticked: [] }),
    ),
  ],
};
