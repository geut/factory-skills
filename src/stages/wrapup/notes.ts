import type { ReviewFinding } from '../../domain.ts';
import { citations } from '../review/parse.ts';
import { parseDecisions } from './checklist.ts';
import { filesLine, handoffSections } from './handoff.ts';

// One note on the handoff diff, in Hunk's agent-context form: above the lines
// `newRange` names, or above the file's first hunk without one.
export type DiffNote = {
  author: 'review' | 'wrap-up';
  newRange?: [number, number];
  rationale?: string;
  summary: string;
};

// Hunk's `--agent-context` sidecar for the handoff diff.
export type DiffNotes = {
  files: Array<{ annotations: Array<DiffNote>; path: string }>;
  version: 1;
};

// The paths a git patch changes.
function patchPaths(diff: string): Set<string> {
  return new Set([...diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)].map((match) => match[1] ?? ''));
}

// The notes a person reads beside the handoff diff: what each file does, from
// ## Files; each decision, where its cited lines are; and each finding the
// latest reviews left, at its location. Only files the diff changes get them.
// Null when there is none.
export function diffNotes(
  diff: string,
  handoff: string,
  findings: Array<{ finding: ReviewFinding; taskId: string }>,
): DiffNotes | null {
  const sections = handoffSections(handoff);
  const changed = patchPaths(diff);
  const notes = new Map<string, Array<DiffNote>>();
  const add = (path: string, note: DiffNote) => {
    if (changed.has(path)) {
      notes.set(path, [...(notes.get(path) ?? []), note]);
    }
  };
  for (const line of (sections.get('files') ?? '').split('\n')) {
    const { note, paths } = filesLine(line);
    if (note.length > 0) {
      for (const path of paths) {
        add(path, { author: 'wrap-up', summary: note });
      }
    }
  }
  for (const decision of parseDecisions(sections.get('decisions') ?? '')) {
    const summary = `Decision: ${decision.replaceAll(/\s*\([^()]*:\d+[^()]*\)/g, '').trim()}`;
    for (const cited of citations(decision)) {
      add(cited.file, { author: 'wrap-up', newRange: [cited.start, cited.end], summary });
    }
  }
  for (const { finding, taskId } of findings) {
    for (const cited of citations(finding.location ?? '')) {
      add(cited.file, {
        author: 'review',
        newRange: [cited.start, cited.end],
        rationale:
          finding.suggestion === null
            ? finding.finding
            : `${finding.finding}\n\nSuggestion: ${finding.suggestion}`,
        summary: `Task ${taskId} ${finding.id} [${finding.severity}] ${finding.title}`,
      });
    }
  }
  if (notes.size === 0) {
    return null;
  }
  return {
    files: [...notes].map(([path, annotations]) => ({ annotations, path })),
    version: 1,
  };
}
