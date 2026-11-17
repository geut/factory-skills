import type { Communication } from '../../communication.ts';
import { handoffSections } from './handoff.ts';

// The pull request body the factory sets from an accepted handoff, when the
// project has no PR format of its own (ADR-004). The agent writes the prose in
// the handoff; the factory picks the sections for the ticket's verbosity and
// signs it in the factory voice.
//
//   minimal, standard  ## Summary, ## Tests
//   full               ## Summary, ## Files, ## Tests, ## Decisions,
//                      ## Limitations, ## Screenshots (those that say something)

const SHORT = [
  ['Summary', 'pr summary'],
  ['Tests', 'tests'],
] as const;

const FULL = [
  ['Summary', 'pr summary'],
  ['Files', 'files'],
  ['Tests', 'tests'],
  ['Decisions', 'decisions'],
  ['Limitations', 'limitations'],
  ['Screenshots', 'screenshots'],
] as const;

// A section that says nothing: empty, or "none".
function says(text: string): boolean {
  return text.length > 0 && !/^none\.?$/i.test(text);
}

export function pullRequestBody(input: {
  communication: Pick<Communication, 'verbosity' | 'voice'>;
  // The ticket as people know it, such as #42 or ENG-42.
  displayRef: string;
  handoff: string;
}): string {
  const sections = handoffSections(input.handoff);
  const parts = (input.communication.verbosity === 'full' ? FULL : SHORT).flatMap(
    ([heading, name]) => {
      const text = sections.get(name) ?? '';
      return says(text) ? [`## ${heading}\n\n${text}`] : [];
    },
  );
  const signature =
    input.communication.voice === 'factory'
      ? [`---\n\nOpened by the factory for ${input.displayRef}.`]
      : [];
  return `${[...parts, ...signature].join('\n\n')}\n`;
}
