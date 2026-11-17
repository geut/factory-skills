import { spawnSync } from 'node:child_process';
import { CONTEXT_FILE_NAMES } from '../review/rules.ts';

// The pull request format a project asks for (ADR-004), read at the ticket's
// base commit so the ticket cannot change the format its own pull request
// follows. In order: PR instructions in the repository root's agent
// instructions, a single pull request template file where GitHub looks for
// one, or the factory's default.

export type PrFormat =
  | { kind: 'default' }
  // A section of AGENTS.md or CLAUDE.md about pull requests: prose the agent
  // follows and the factory cannot check.
  | { kind: 'instructions'; path: string; text: string }
  // A template file: its headings must all be in the body, in order.
  | { headings: Array<string>; kind: 'template'; path: string; text: string };

// Where GitHub looks for a single template, in the order it picks one. A
// PULL_REQUEST_TEMPLATE/ directory only applies when a link asks for it.
const TEMPLATE_DIRECTORIES = ['.github', '', 'docs'] as const;
const TEMPLATE_NAME = 'pull_request_template.md';

type Heading = { level: number; line: number; text: string };

// A markdown document's headings, outside code fences and HTML comments.
function headingsOf(text: string): Array<Heading> {
  const headings: Array<Heading> = [];
  let fenced = false;
  let commented = false;
  for (const [line, raw] of text.split('\n').entries()) {
    const trimmed = raw.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      fenced = !fenced;
      continue;
    }
    if (commented || trimmed.startsWith('<!--')) {
      commented = !trimmed.includes('-->');
      continue;
    }
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (!fenced && match?.[1] !== undefined && match[2] !== undefined) {
      headings.push({ level: match[1].length, line, text: match[2] });
    }
  }
  return headings;
}

const key = (text: string) => text.trim().toLowerCase().replaceAll(/\s+/g, ' ');

// The section of agent instructions about pull requests: the first heading
// that names them, down to the next heading at its level or above.
export function prInstructions(text: string): string | null {
  const headings = headingsOf(text);
  const index = headings.findIndex((heading) =>
    /\bpull[ -]requests?\b|\bPRs?\b/i.test(heading.text),
  );
  const found = headings[index];
  if (found === undefined) {
    return null;
  }
  const end = headings.slice(index + 1).find((heading) => heading.level <= found.level);
  const lines = text.split('\n').slice(found.line, end?.line);
  return lines.join('\n').trim();
}

export function templateHeadings(template: string): Array<string> {
  return headingsOf(template).map((heading) => heading.text);
}

// The template's headings a body is missing, or has out of order: each one
// must come after the one before it.
export function missingHeadings(headings: Array<string>, body: string): Array<string> {
  const found = headingsOf(body).map((heading) => key(heading.text));
  const missing: Array<string> = [];
  let from = 0;
  for (const heading of headings) {
    const at = found.indexOf(key(heading), from);
    if (at < 0) {
      missing.push(heading);
    } else {
      from = at + 1;
    }
  }
  return missing;
}

function git(codeRoot: string, args: Array<string>): string | null {
  const result = spawnSync('git', ['--literal-pathspecs', ...args], {
    cwd: codeRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : null;
}

// A file's text at the base commit, or null when it is not there.
function textAt(codeRoot: string, sha: string, file: string): string | null {
  return git(codeRoot, ['show', `${sha}:${file}`]);
}

// The repository paths directly in `directory` at the base commit.
function namesIn(codeRoot: string, sha: string, directory: string): Array<string> {
  const listed = git(codeRoot, [
    'ls-tree',
    '--name-only',
    `${sha}^{commit}`,
    '--',
    directory === '' ? '.' : `${directory}/`,
  ]);
  return listed === null ? [] : listed.split('\n').filter((line) => line.length > 0);
}

export function readPrFormat(input: { codeRoot: string; sha: string }): PrFormat {
  const { codeRoot, sha } = input;
  // Pi loads the first of these the root has, so only that one counts.
  for (const name of CONTEXT_FILE_NAMES) {
    const text = textAt(codeRoot, sha, name);
    if (text === null) {
      continue;
    }
    const section = prInstructions(text);
    if (section !== null) {
      return { kind: 'instructions', path: name, text: section };
    }
    break;
  }
  for (const directory of TEMPLATE_DIRECTORIES) {
    const file = namesIn(codeRoot, sha, directory).find(
      (name) => name.split('/').at(-1)?.toLowerCase() === TEMPLATE_NAME,
    );
    const text = file === undefined ? null : textAt(codeRoot, sha, file);
    if (file !== undefined && text !== null) {
      return { headings: templateHeadings(text), kind: 'template', path: file, text };
    }
  }
  return { kind: 'default' };
}
