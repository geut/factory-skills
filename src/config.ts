import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { StageSettings } from './stages/definition.ts';
import { stageLimits, stages } from './stages/index.ts';

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const INTERNAL_LABELS = ['investigation'] as const;
export type InternalLabel = (typeof INTERNAL_LABELS)[number];

export type WorkCommand = {
  argv: Array<string>;
  name: string;
  timeoutMs: number;
};

// The controller's own limit, then each stage's (see src/stages/index.ts).
const limitSpecs = { infrastructureRetries: { default: 3, min: 0 }, ...stageLimits };

export type Limits = Record<keyof typeof limitSpecs, number>;

const LIMIT_KEYS = Object.keys(limitSpecs) as Array<keyof typeof limitSpecs>;

export const DEFAULT_LIMITS = Object.fromEntries(
  LIMIT_KEYS.map((key) => [key, limitSpecs[key].default]),
) as Limits;

export type FactoryConfig = {
  github: { host: string; owner: string; pullRequests: boolean; repo: string } | null;
  keys: Record<string, { provider: 'github' }>;
  labels: { map: Record<string, InternalLabel> };
  limits: Limits;
  models: { plan: string; review: string; work: string };
  stages: Record<string, StageSettings>;
  validation: Validation;
};

// `wrapup.generated` lists path prefixes or `*` globs of generated artifacts
// the wrap-up agent may refresh, such as `docs/api/` or `*.snap`.
export type Validation = {
  work: { commands: Array<WorkCommand> };
  wrapup: { generated: Array<string> };
};

export type ConfigResult =
  | { config: FactoryConfig; kind: 'ok' }
  | { kind: 'error'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readLimit(record: Record<string, unknown>, key: string, fallback: number): number | null {
  if (!(key in record)) {
    return fallback;
  }
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function isInternalLabel(value: string): value is InternalLabel {
  return INTERNAL_LABELS.some((label) => label === value);
}

function readLabelMap(value: unknown): FactoryConfig['labels'] | null {
  if (value === undefined) {
    return { map: {} };
  }
  if (!isRecord(value)) {
    return null;
  }
  const mapValue = value['map'] ?? {};
  if (!isRecord(mapValue)) {
    return null;
  }
  const map: Record<string, InternalLabel> = {};
  for (const [projectLabel, internal] of Object.entries(mapValue)) {
    if (
      projectLabel.trim().length === 0 ||
      typeof internal !== 'string' ||
      !isInternalLabel(internal)
    ) {
      return null;
    }
    map[projectLabel] = internal;
  }
  return { map };
}

function readTimeout(value: unknown): number | null {
  if (value === undefined) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function readCommands(value: unknown): Array<WorkCommand> | null {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return null;
  }
  const work = value['work'] ?? {};
  if (!isRecord(work)) {
    return null;
  }
  const commands = work['commands'] ?? [];
  if (!Array.isArray(commands)) {
    return null;
  }
  const parsed: Array<WorkCommand> = [];
  for (const command of commands) {
    if (!isRecord(command)) {
      return null;
    }
    const name = readString(command, 'name');
    const timeoutMs = readTimeout(command['timeoutMs']);
    const argvValue = command['argv'];
    if (
      name === null ||
      timeoutMs === null ||
      !Array.isArray(argvValue) ||
      argvValue.length === 0 ||
      argvValue.some((arg) => typeof arg !== 'string' || arg.length === 0)
    ) {
      return null;
    }
    parsed.push({ argv: argvValue, name, timeoutMs });
  }
  return parsed;
}

function readGenerated(value: unknown): Array<string> | null {
  if (value === undefined || !isRecord(value) || value['wrapup'] === undefined) {
    return [];
  }
  const wrapup = value['wrapup'];
  if (!isRecord(wrapup)) {
    return null;
  }
  const generated = wrapup['generated'] ?? [];
  if (
    !Array.isArray(generated) ||
    generated.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    return null;
  }
  return generated.map((item: string) => item.trim());
}

export function allowsEmptyDiff(
  labels: Array<string>,
  map: Record<string, InternalLabel>,
): boolean {
  return labels.some((label) => label === 'investigation' || map[label] === 'investigation');
}

export function parseFactoryConfig(value: unknown): ConfigResult {
  if (!isRecord(value)) {
    return { kind: 'error', message: 'FACTORY.json must be an object.' };
  }
  const modelsValue = value['models'];
  if (!isRecord(modelsValue)) {
    return { kind: 'error', message: 'FACTORY.json needs models.work and models.review.' };
  }
  const work = readString(modelsValue, 'work');
  const review = readString(modelsValue, 'review');
  const plan = readString(modelsValue, 'plan') ?? work;
  if (work === null || review === null || plan === null) {
    return { kind: 'error', message: 'FACTORY.json needs models.work and models.review.' };
  }
  if (work === review) {
    return { kind: 'error', message: 'models.review must be different from models.work.' };
  }

  const limitsValue = value['limits'];
  const limits: Limits = { ...DEFAULT_LIMITS };
  if (limitsValue !== undefined) {
    if (!isRecord(limitsValue)) {
      return { kind: 'error', message: 'FACTORY.json limits must be an object.' };
    }
    for (const key of LIMIT_KEYS) {
      const limit = readLimit(limitsValue, key, DEFAULT_LIMITS[key]);
      if (limit === null) {
        return { kind: 'error', message: 'FACTORY.json limits must be non-negative integers.' };
      }
      if (limit < limitSpecs[key].min) {
        return {
          kind: 'error',
          message: `FACTORY.json limits.${key} must be at least ${limitSpecs[key].min}.`,
        };
      }
      limits[key] = limit;
    }
  }

  const labels = readLabelMap(value['labels']);
  if (labels === null) {
    return {
      kind: 'error',
      message: 'FACTORY.json labels.map values must be internal labels such as investigation.',
    };
  }
  const commands = readCommands(value['validation']);
  if (commands === null) {
    return {
      kind: 'error',
      message:
        'FACTORY.json validation.work.commands must be objects with a name, an argv array, and an optional timeoutMs.',
    };
  }

  const generated = readGenerated(value['validation']);
  if (generated === null) {
    return {
      kind: 'error',
      message: 'FACTORY.json validation.wrapup.generated must be an array of paths.',
    };
  }

  let github: FactoryConfig['github'] = null;
  if (value['github'] !== undefined) {
    const githubValue = value['github'];
    if (!isRecord(githubValue)) {
      return { kind: 'error', message: 'FACTORY.json github must be an object.' };
    }
    const owner = readString(githubValue, 'owner');
    const repo = readString(githubValue, 'repo');
    const host = readString(githubValue, 'host') ?? 'github.com';
    if (owner === null || repo === null) {
      return { kind: 'error', message: 'FACTORY.json github needs owner and repo.' };
    }
    const pullRequests = githubValue['pullRequests'] ?? false;
    if (typeof pullRequests !== 'boolean') {
      return { kind: 'error', message: 'FACTORY.json github.pullRequests must be true or false.' };
    }
    github = { host, owner, pullRequests, repo };
  }

  const keys: FactoryConfig['keys'] = {};
  if (value['keys'] !== undefined) {
    const keysValue = value['keys'];
    if (!isRecord(keysValue)) {
      return { kind: 'error', message: 'FACTORY.json keys must be an object.' };
    }
    for (const [name, spec] of Object.entries(keysValue)) {
      if (!isRecord(spec) || spec['provider'] !== 'github') {
        return { kind: 'error', message: `FACTORY.json key ${name} must set provider to github.` };
      }
      keys[name] = { provider: 'github' };
    }
  }

  const settings = readStageSettings(value['stages']);
  if (settings.kind === 'error') {
    return settings;
  }

  return {
    config: {
      github,
      keys,
      labels,
      limits,
      models: { plan, review, work },
      stages: settings.stages,
      validation: { work: { commands }, wrapup: { generated } },
    },
    kind: 'ok',
  };
}

// `stages.<name>` holds an optional stage's settings, which that stage reads.
export function readStageSettings(
  value: unknown,
): { kind: 'ok'; stages: Record<string, StageSettings> } | { kind: 'error'; message: string } {
  if (value === undefined) {
    return { kind: 'ok', stages: {} };
  }
  if (!isRecord(value)) {
    return { kind: 'error', message: 'FACTORY.json stages must be an object.' };
  }
  const read: Record<string, StageSettings> = {};
  for (const [name, raw] of Object.entries(value)) {
    const definition = Object.values(stages).find((stage) => stage.name === name);
    if (definition?.settings === undefined) {
      return { kind: 'error', message: `FACTORY.json stages.${name} is not an optional stage.` };
    }
    const result = definition.settings(raw);
    if (result.kind === 'error') {
      return result;
    }
    read[name] = result.settings;
  }
  return { kind: 'ok', stages: read };
}

export function readFactoryConfig(factoryRoot: string): ConfigResult {
  const file = path.join(factoryRoot, 'FACTORY.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {
      kind: 'error',
      message: `Missing ${file}. Create FACTORY.json with models.work and models.review before /factory start.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'error', message: `${file} is not valid JSON.` };
  }
  return parseFactoryConfig(parsed);
}
