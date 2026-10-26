import { readFileSync } from 'node:fs';
import path from 'node:path';

// `<factory root>/CONTEXT.md`: the facts every ticket's agents would otherwise
// rediscover. The first plan in a factory root writes it with these sections,
// in this order; a section with nothing to say reads `none known yet`.
export const CONTEXT_SECTIONS = [
  'Commands',
  'Environment',
  'Test layers',
  'Servers and ports',
  'Known flakes',
  'Fixtures and fakes',
  'Vocabulary',
] as const;

// Every session loads the file, so it stays short. Over this is a warning.
export const CONTEXT_LINE_BUDGET = 150;

export function contextPathOf(factoryRoot: string): string {
  return path.join(factoryRoot, 'CONTEXT.md');
}

// What the plan prompt needs to know: whether to create the file, or which
// sections a file someone already wrote still lacks.
export type ContextGaps = { kind: 'missing' } | { kind: 'read'; missingSections: Array<string> };

export type ContextInspection =
  | { kind: 'missing' }
  | {
      // Sections whose heading is there with nothing under it.
      emptySections: Array<string>;
      kind: 'read';
      lines: number;
      missingSections: Array<string>;
    };

export function inspectContext(factoryRoot: string): ContextInspection {
  let text: string;
  try {
    text = readFileSync(contextPathOf(factoryRoot), 'utf8');
  } catch {
    return { kind: 'missing' };
  }
  if (text.trim().length === 0) {
    return { kind: 'missing' };
  }
  // Each `##` heading, lowercased, with the text up to the next heading.
  const bodies = new Map<string, string>();
  for (const part of text.split(/^(?=##\s)/m)) {
    const match = /^##\s+(.+?)\s*#*\s*$/m.exec(part);
    if (match !== null && part.startsWith('##')) {
      bodies.set(match[1]?.toLowerCase() ?? '', part.slice(match[0].length).trim());
    }
  }
  return {
    emptySections: CONTEXT_SECTIONS.filter((section) => bodies.get(section.toLowerCase()) === ''),
    kind: 'read',
    lines: text.trimEnd().split('\n').length,
    missingSections: CONTEXT_SECTIONS.filter((section) => !bodies.has(section.toLowerCase())),
  };
}

// The sentence that asks for the file, shared by the plan prompt and its correction.
export function createContextInstruction(factoryRoot: string): string {
  return `Create ${contextPathOf(factoryRoot)} with these ## sections, in this order: ${CONTEXT_SECTIONS.join(', ')}. A section with nothing known says "none known yet".`;
}

// The plan prompt's line about CONTEXT.md, or null when the file is complete.
export function contextInstruction(gaps: ContextGaps, factoryRoot: string): string | null {
  if (gaps.kind === 'missing') {
    return `${createContextInstruction(factoryRoot)} It does not exist yet: fill it from what you learn exploring the repo and keep it under ${CONTEXT_LINE_BUDGET} lines. The skill's references/context.md describes each section.`;
  }
  if (gaps.missingSections.length > 0) {
    return `Add the ${gaps.missingSections.map((section) => `## ${section}`).join(', ')} section${gaps.missingSections.length === 1 ? '' : 's'} to ${contextPathOf(factoryRoot)}, saying "none known yet" where nothing is known. Leave the rest of the file as it is.`;
  }
  return null;
}

export function contextGaps(factoryRoot: string): ContextGaps {
  const context = inspectContext(factoryRoot);
  return context.kind === 'missing'
    ? context
    : { kind: 'read', missingSections: context.missingSections };
}
