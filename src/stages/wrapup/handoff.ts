// The wrap-up handoff is markdown; its level-2 headings make it complete.

export const WRAPUP_HEADINGS = [
  'Outcome',
  'PR summary',
  'Files',
  'Tests',
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
