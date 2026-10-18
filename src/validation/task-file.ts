import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// A task file starts with YAML frontmatter holding what the planner decides
// about the task. Status and stage are the controller's and live in its store.
const frontmatterPattern = /^﻿?---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

const taskTypes = ['bug', 'feature', 'performance', 'refactor', 'investigation'] as const;

// A dependency names another task file by its number (1, 01, "01") or its
// filename. YAML reads an unquoted 01 as the number 1, so numbers compare by
// value.
const dependency = z.union([z.number().int().nonnegative(), z.string().trim().min(1)]);

const frontmatterSchema = z.strictObject({
  blocked_by: z.array(dependency),
  qa: z.enum(['e2e', 'none']),
  type: z.enum(taskTypes),
});

export type TaskFrontmatter = z.infer<typeof frontmatterSchema>;

export type TaskFile =
  | { body: string; frontmatter: TaskFrontmatter; kind: 'parsed' }
  | { failures: Array<string>; kind: 'failed' };

const fields = 'type, qa and blocked_by';

function issueText(issue: z.core.$ZodIssue, data: object): string {
  const key = issue.path.join('.');
  if (issue.code === 'unrecognized_keys') {
    return `has ${issue.keys.join(', ')} in its frontmatter, which holds only ${fields}`;
  }
  if (issue.path.length === 1 && !(key in data)) {
    return `has no ${key} in its frontmatter`;
  }
  return `has an invalid ${key || 'frontmatter'}: ${issue.message}`;
}

const legacyLine = /^(Status|Type|QA|Blocked by):[ \t]*(.*)$/gim;

// Task files once carried `Type:`, `QA:` and `Blocked by:` lines. A file that
// still does gets the frontmatter those lines become, so one correction
// converts it. The suggestion is only a hint: validation checks what is written.
function legacyHint(filename: string, text: string): string | null {
  const lines = new Map<string, string>();
  for (const match of text.matchAll(legacyLine)) {
    lines.set((match[1] ?? '').toLowerCase(), (match[2] ?? '').trim());
  }
  if (lines.size === 0) {
    return null;
  }
  const type = lines.get('type')?.toLowerCase() ?? '';
  const qa = lines.get('qa')?.toLowerCase() ?? 'e2e';
  const blocked = lines.get('blocked by') ?? 'none';
  const deps =
    blocked.toLowerCase() === 'none'
      ? []
      : blocked
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
  const frontmatter = [
    '---',
    `type: ${(taskTypes as ReadonlyArray<string>).includes(type) ? type : taskTypes.join(' | ')}`,
    `qa: ${qa === 'e2e' || qa === 'none' ? qa : 'e2e | none'}`,
    `blocked_by: [${deps.map((dep) => JSON.stringify(dep)).join(', ')}]`,
    '---',
  ];
  return `${filename} uses the old Status, Type, QA and Blocked by lines. Delete them and start the file with this frontmatter instead:\n${frontmatter.join('\n')}`;
}

export function readTaskFile(filename: string, text: string): TaskFile {
  const match = frontmatterPattern.exec(text);
  if (match === null) {
    return {
      failures: [
        legacyHint(filename, text) ??
          `${filename} has no frontmatter; start it with ---, then ${fields}, then ---.`,
      ],
      kind: 'failed',
    };
  }
  let data: unknown;
  try {
    data = parseYaml(match[1] ?? '');
  } catch (error: unknown) {
    const message = (error instanceof Error ? error.message : String(error))
      .split('\n')[0]
      ?.replace(/:$/, '');
    return {
      failures: [`${filename} has frontmatter that is not YAML: ${message}.`],
      kind: 'failed',
    };
  }
  const fieldsFound = typeof data === 'object' && data !== null ? data : {};
  const result = frontmatterSchema.safeParse(fieldsFound);
  if (!result.success) {
    return {
      failures: result.error.issues.map((issue) => `${filename} ${issueText(issue, fieldsFound)}.`),
      kind: 'failed',
    };
  }
  return { body: text.slice(match[0].length), frontmatter: result.data, kind: 'parsed' };
}
