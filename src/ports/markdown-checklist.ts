import type { ChecklistItem } from './tracker.ts';

// Markdown task-list boxes in an issue body: `- [ ] text` or `1. [ ] text`,
// outside code fences. Adapters of trackers whose issues keep Markdown bodies,
// such as GitHub, read and tick their checklist with these. A box's key is
// its text and which box of that text it is, `2:Survives a reload`, so a
// box someone rewords no longer matches.

type Box = { checked: boolean; key: string; line: number; mark: number; text: string };

// Every box in `lines`: its line, the column of its mark, and its text.
function boxes(lines: Array<string>): Array<Box> {
  const found: Array<Box> = [];
  const seen = new Map<string, number>();
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
      const text = match[3] ?? '';
      const nth = (seen.get(text) ?? 0) + 1;
      seen.set(text, nth);
      found.push({
        checked: match[2] !== ' ',
        key: `${nth}:${text}`,
        line,
        mark: (match[1] ?? '').length,
        text,
      });
    }
  }
  return found;
}

// Every box of an issue body, in order.
export function markdownChecklist(body: string): Array<ChecklistItem> {
  return boxes(body.split('\n')).map((item) => ({
    done: item.checked,
    key: item.key,
    text: item.text,
  }));
}

// Ticks the open box of each key and changes nothing else in the body. A box
// already ticked stays as it is; a key no box has any more, because someone
// edited the issue, is a conflict.
export function tickMarkdown(
  body: string,
  keys: Array<string>,
): { body: string; conflicts: Array<string> } {
  const lines = body.split('\n');
  const found = boxes(lines);
  const conflicts: Array<string> = [];
  for (const key of keys) {
    const box = found.find((item) => item.key === key);
    if (box === undefined) {
      conflicts.push(key);
    } else if (!box.checked) {
      const content = lines[box.line] ?? '';
      lines[box.line] = `${content.slice(0, box.mark)}x${content.slice(box.mark + 1)}`;
      box.checked = true;
    }
  }
  return { body: lines.join('\n'), conflicts };
}
