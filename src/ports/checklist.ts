// Markdown task-list boxes in an issue body: `- [ ] text` or `1. [ ] text`,
// outside code fences. Trackers that keep Markdown bodies share these.

export type Checkbox = { id: string; text: string };

type Box = { checked: boolean; line: number; mark: number; text: string };

// Every box in `lines`: its line, the column of its mark, and its text.
function boxes(lines: Array<string>): Array<Box> {
  const found: Array<Box> = [];
  // The marker that opened the code fence we are in; a fence closes on its own kind.
  let fence: string | null = null;
  for (const [line, content] of lines.entries()) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(content)?.[1] ?? null;
    if (marker !== null && (fence === null || marker.startsWith(fence))) {
      fence = fence === null ? marker : null;
      continue;
    }
    const match =
      fence === null ? /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]\s+(.*?)\s*$/.exec(content) : null;
    if (match !== null) {
      found.push({
        checked: match[2] !== ' ',
        line,
        mark: (match[1] ?? '').length,
        text: match[3] ?? '',
      });
    }
  }
  return found;
}

// The open boxes of an issue body, numbered B1..Bn in order.
export function issueCheckboxes(body: string): Array<Checkbox> {
  return boxes(body.split('\n'))
    .filter((item) => !item.checked)
    .map((item, index) => ({ id: `B${index + 1}`, text: item.text }));
}

// Ticks the open box of each text and changes nothing else in the body. A box
// already ticked stays as it is; a text no box has any more, because someone
// edited the issue, is a conflict.
export function tickCheckboxes(
  body: string,
  texts: Array<string>,
): { body: string; conflicts: Array<string> } {
  const lines = body.split('\n');
  const found = boxes(lines);
  const conflicts: Array<string> = [];
  for (const text of texts) {
    const open = found.find((item) => !item.checked && item.text === text.trim());
    if (open !== undefined) {
      const content = lines[open.line] ?? '';
      lines[open.line] = `${content.slice(0, open.mark)}x${content.slice(open.mark + 1)}`;
      open.checked = true;
    } else if (!found.some((item) => item.text === text.trim())) {
      conflicts.push(text);
    }
  }
  return { body: lines.join('\n'), conflicts };
}
