import path from 'node:path';

// One acceptance criterion of a task, numbered AC1..ACn in the order the task
// file lists them.
export type Criterion = { id: string; text: string };

function section(markdown: string, heading: string): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`);
  if (start === -1) {
    return null;
  }
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

// The items under the task file's `## Acceptance criteria`, checked or not.
// An item runs on over the indented lines that wrap it.
export function acceptanceCriteria(taskMarkdown: string): Array<Criterion> {
  const body = section(taskMarkdown, 'acceptance criteria') ?? '';
  const items: Array<string> = [];
  let open = false;
  for (const line of body.split('\n')) {
    const item = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line)?.[1];
    if (item !== undefined) {
      items.push(item);
      open = true;
    } else if (open && /^\s+\S/.test(line)) {
      items[items.length - 1] += ` ${line.trim()}`;
    } else {
      open = false;
    }
  }
  return items.map((text, index) => ({ id: `AC${index + 1}`, text }));
}

// One row of the test plan: the criterion, the test that proves it, and the
// screenshots it captured, relative to the task's QA directory.
export type PlannedTest = { criterion: string; screenshots: Array<string>; test: string };

// A screenshot cell holds `none` or one or more image paths, possibly with
// prose around them. Without an image path, the whole cell is the path, so
// the validator reports it as missing.
function screenshotPaths(cell: string): Array<string> {
  const text = cell.trim();
  if (text === '' || text.toLowerCase() === 'none') {
    return [];
  }
  const images = text.match(/[\w./-]+\.(?:png|jpe?g|gif|webp)\b/gi);
  return images === null ? [text] : [...new Set(images)];
}

// A table row's cells. A pipe escaped as `\|` stays inside its cell.
function cells(line: string): Array<string> {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replaceAll(String.raw`\|`, '|').trim());
}

// The rows of the `| AC | Test | Screenshot |` table in test-plan.md.
export function testPlan(markdown: string): Array<PlannedTest> {
  return markdown
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map(cells)
    .filter(([criterion]) => /^AC\d+$/i.test(criterion ?? ''))
    .map(([criterion = '', test = '', screenshot = '']) => ({
      criterion: criterion.toUpperCase(),
      screenshots: screenshotPaths(screenshot),
      test,
    }));
}

// The test-gap ledger's `- ACn: reason` items, by criterion.
export function testGaps(markdown: string): Map<string, string> {
  const gaps = new Map<string, string>();
  for (const line of markdown.split('\n')) {
    const match = /^\s*[-*]\s+(AC\d+)\s*[:—-]\s*(.*?)\s*$/i.exec(line);
    if (match?.[1] !== undefined) {
      gaps.set(match[1].toUpperCase(), match[2] ?? '');
    }
  }
  return gaps;
}

// Where QA keeps a task's test plan, ledger, and screenshots.
export function qaPaths(factoryDir: string, taskId: string) {
  const dir = path.join(factoryDir, 'qa', taskId);
  return {
    dir,
    ledger: path.join(dir, 'ledger.md'),
    plan: path.join(dir, 'test-plan.md'),
    screenshots: path.join(dir, 'screenshots'),
  };
}
