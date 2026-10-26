// The wrap-up handoff is markdown; its level-2 headings make it complete.

export const WRAPUP_HEADINGS = [
  'Outcome',
  'PR summary',
  'Files',
  'Tests',
  'Issue checklist',
  'Decisions',
  'Operations',
  'Limitations',
  'Merge commands',
] as const;

export function handoffSections(output: string): Map<string, string> {
  const sections = new Map<string, string>();
  const text = output.trim().replace(/^```[\w-]*\n([\s\S]*)\n```$/, '$1');
  const matches = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    sections.set((match[1] ?? '').trim().toLowerCase(), text.slice(start, end).trim());
  });
  return sections;
}

function cleanPath(value: string): string {
  return value
    .trim()
    .replace(/^\.\//, '')
    .replace(/[,;:]$/, '');
}

// One ## Files line: the paths before its dash or colon (backticked ones, else
// the first word), and what it says about them after it.
export function filesLine(line: string): { note: string; paths: Array<string> } {
  const item = line
    .trim()
    .replace(/^(?:[-*+]|\d+\.)\s+/, '')
    .replace(/^\*\*[^*]+\*\*:?\s*/, '');
  const split = /\s+(?:—|–|--|-)\s+|:\s+/.exec(item);
  const head = split === null ? item : item.slice(0, split.index);
  const quoted = [...head.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
  const paths = (quoted.length > 0 ? quoted : head.split(/\s+/).slice(0, 1))
    .map(cleanPath)
    .filter(
      (value) =>
        value.length > 0 &&
        !value.includes(' ') &&
        !/^[a-z]+:\/\//i.test(value) &&
        (value.includes('/') || /\.[A-Za-z0-9]+$/.test(value)),
    );
  return { note: split === null ? '' : item.slice(split.index + split[0].length).trim(), paths };
}

// Paths named in the Files section.
export function listedPaths(section: string): Set<string> {
  return new Set(section.split('\n').flatMap((line) => filesLine(line).paths));
}
