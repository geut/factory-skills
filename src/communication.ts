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
