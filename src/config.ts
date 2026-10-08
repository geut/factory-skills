import { readFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const INTERNAL_LABELS = ['investigation'] as const;
export type InternalLabel = (typeof INTERNAL_LABELS)[number];

export type WorkCommand = {
  argv: Array<string>;
  name: string;
  timeoutMs: number;
};

export type FactoryConfig = {
  github: { host: string; owner: string; repo: string } | null;
  keys: Record<string, { provider: 'github' }>;
  labels: { map: Record<string, InternalLabel> };
  limits: { infrastructureRetries: number; planCorrections: number; workCorrections: number };
  models: { plan: string; review: string; work: string };
  validation: { work: { commands: Array<WorkCommand> } };
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
  let planCorrections = 3;
  let workCorrections = 3;
  let infrastructureRetries = 3;
  if (limitsValue !== undefined) {
    if (!isRecord(limitsValue)) {
      return { kind: 'error', message: 'FACTORY.json limits must be an object.' };
    }
    const planLimit = readLimit(limitsValue, 'planCorrections', 3);
    const workLimit = readLimit(limitsValue, 'workCorrections', 3);
    const retries = readLimit(limitsValue, 'infrastructureRetries', 3);
    if (planLimit === null || workLimit === null || retries === null) {
      return { kind: 'error', message: 'FACTORY.json limits must be non-negative integers.' };
    }
    planCorrections = planLimit;
    workCorrections = workLimit;
    infrastructureRetries = retries;
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
    github = { host, owner, repo };
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

  return {
    config: {
      github,
      keys,
      labels,
      limits: { infrastructureRetries, planCorrections, workCorrections },
      models: { plan, review, work },
      validation: { work: { commands } },
    },
    kind: 'ok',
  };
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
