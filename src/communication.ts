import { z } from 'zod';

// How the factory communicates outside (ADR-004): how much it writes on the
// tracker and the pull request, and whose voice it writes in. FACTORY.json's
// `communication` block; each ticket keeps the settings it started with.

export const VERBOSITIES = ['minimal', 'standard', 'full'] as const;
export const VOICES = ['factory', 'developer'] as const;
export const DEFAULT_TONE = 'succinct, technical, to the point';
export const MAX_TONE_LENGTH = 500;

const verbosity = z.enum(VERBOSITIES).meta({
  description:
    'How much the factory writes outside: `minimal` only the pull request, `standard` adds a short handoff comment and checklist ticks, `full` everything, as before.',
});
const voice = z.enum(VOICES).meta({
  description:
    '`factory` speaks of itself in the third person; `developer` reads as the factory’s owner, in the first person.',
});
const tone = z.string().trim().min(1).max(MAX_TONE_LENGTH).meta({
  description: 'How the `developer` voice should sound, in the owner’s words.',
});

export const Communication = z
  .object({ tone, verbosity, voice })
  .strict()
  .meta({ id: 'Communication' });

export type Communication = z.infer<typeof Communication>;

export const DEFAULT_COMMUNICATION: Communication = {
  tone: DEFAULT_TONE,
  verbosity: 'full',
  voice: 'factory',
};

// In FACTORY.json every field may be left out and takes its default.
const FileCommunication = z
  .object({
    tone: tone.default(DEFAULT_COMMUNICATION.tone),
    verbosity: verbosity.default(DEFAULT_COMMUNICATION.verbosity),
    voice: voice.default(DEFAULT_COMMUNICATION.voice),
  })
  .strict();

const FIELD_RULES: Record<string, string> = {
  tone: `a non-empty string of at most ${MAX_TONE_LENGTH} characters`,
  verbosity: `one of ${VERBOSITIES.join(', ')}`,
  voice: `one of ${VOICES.join(', ')}`,
};

// FACTORY.json's `communication`, with defaults, or a message naming the field.
export function readCommunication(value: unknown): Communication | string {
  if (value === undefined) {
    return DEFAULT_COMMUNICATION;
  }
  const parsed = FileCommunication.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  const field = issue?.path[0];
  if (typeof field === 'string' && field in FIELD_RULES) {
    return `FACTORY.json communication.${field} must be ${FIELD_RULES[field]}.`;
  }
  if (issue?.code === 'unrecognized_keys') {
    return `FACTORY.json communication takes only ${Object.keys(FIELD_RULES).join(', ')}; ${issue.keys.join(', ')} is not one.`;
  }
  return 'FACTORY.json communication must be an object.';
}

// An execution's stored settings. Executions started before them, or with a
// value the current rules refuse, communicate the way the factory always did.
export function storedCommunication(value: unknown): Communication {
  const parsed = Communication.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_COMMUNICATION;
}

// FACTORY.json's text with its top-level `communication` set to these settings
// on one line, and every other byte as it was: the block is replaced where it
// stands, or added as the last key. `text` must already parse as a JSON object.
export function withCommunication(text: string, communication: Communication): string {
  const block = `{ "verbosity": ${JSON.stringify(communication.verbosity)}, "voice": ${JSON.stringify(communication.voice)}, "tone": ${JSON.stringify(communication.tone)} }`;
  const span = topLevelValue(text, 'communication');
  if (span !== null) {
    return `${text.slice(0, span.start)}${block}${text.slice(span.end)}`;
  }
  const close = text.lastIndexOf('}');
  const before = text.slice(0, close).trimEnd();
  // The file's indentation: a tab, or the spaces of its first key.
  const indent = /^\{\r?\n([\t ]+)"/.exec(text)?.[1] ?? '  ';
  const separator = before.endsWith('{') ? '' : ',';
  return `${before}${separator}\n${indent}"communication": ${block}\n${text.slice(close)}`;
}

// Where a top-level key's value starts and ends in a JSON object's text.
function topLevelValue(text: string, key: string): { end: number; start: number } | null {
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = stringEnd(text, index);
      const colon = skipSpace(text, end);
      if (depth === 1 && text[colon] === ':' && JSON.parse(text.slice(index, end)) === key) {
        const start = skipSpace(text, colon + 1);
        return { end: valueEnd(text, start), start };
      }
      index = end;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
    }
    index += 1;
  }
  return null;
}

// The index just past the string that opens at `start`.
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length && text[index] !== '"') {
    index += text[index] === '\\' ? 2 : 1;
  }
  return index + 1;
}

function skipSpace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? '')) {
    index += 1;
  }
  return index;
}

// The index just past the value that starts at `start`.
function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"') {
    return stringEnd(text, start);
  }
  if (first !== '{' && first !== '[') {
    // A number, true, false, or null runs to the next delimiter.
    let index = start;
    while (index < text.length && !/[\s,}\]]/.test(text[index] ?? '')) {
      index += 1;
    }
    return index;
  }
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index = stringEnd(text, index);
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }
  return index;
}
