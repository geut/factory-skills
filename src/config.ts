import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { StageSettings } from './stages/definition.ts';
import { stageLimits, stages } from './stages/index.ts';

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_SERVER = { host: '127.0.0.1', port: 7731 };
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

// The statuses the factory writes to a ticket's issue; see tracker updates.
export type TrackerStatus = 'in_progress' | 'in_review';

// Where issues and the backlog live. Only GitHub has an adapter so far.
export type TrackerConfig = {
  // Which open issues the backlog shows. GitHub filters by labels and milestone.
  backlog: { labels: Array<string>; milestone: string | null };
  host: string;
  kind: 'github';
  owner: string;
  repo: string;
  // How each factory status shows on the issue; an unmapped status is not written.
  status: Partial<Record<TrackerStatus, { label: string }>>;
};

// Where the repository and its pull requests live.
export type CodeHostConfig = {
  host: string;
  kind: 'github';
  owner: string;
  // Whether wrap-up may push the branch and open a pull request.
  pullRequests: boolean;
  repo: string;
  // The environment variable that holds the webhook secret, if any.
  webhookSecretEnv: string | null;
};

export type FactoryConfig = {
  codeHost: CodeHostConfig | null;
  labels: { map: Record<string, InternalLabel> };
  limits: Limits;
  models: { plan: string; review: string; work: string };
  // How people tell this factory apart from others in exported stats.
  name: string | null;
  // Where `factory serve` listens. Bind 0.0.0.0 to publish the port from a sandbox.
  server: { host: string; port: number };
  stages: Record<string, StageSettings>;
  tracker: TrackerConfig | null;
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

  if (value['github'] !== undefined || value['keys'] !== undefined) {
    return {
      kind: 'error',
      message:
        'FACTORY.json github and keys were replaced by tracker and codeHost. Move github.owner and github.repo into both, as { "kind": "github", "owner": ..., "repo": ... }, and github.pullRequests into codeHost.pullRequests.',
    };
  }
  const tracker = readTracker(value['tracker']);
  if (typeof tracker === 'string') {
    return { kind: 'error', message: tracker };
  }
  const codeHost = readCodeHost(value['codeHost']);
  if (typeof codeHost === 'string') {
    return { kind: 'error', message: codeHost };
  }

  const server = readServer(value['server']);
  if (server === null) {
    return {
      kind: 'error',
      message: 'FACTORY.json server needs a non-empty host and an integer port from 1 to 65535.',
    };
  }

  const settings = readStageSettings(value['stages']);
  if (settings.kind === 'error') {
    return settings;
  }

  return {
    config: {
      codeHost,
      labels,
      limits,
      models: { plan, review, work },
      name: readString(value, 'name'),
      server,
      stages: settings.stages,
      tracker,
      validation: { work: { commands }, wrapup: { generated } },
    },
    kind: 'ok',
  };
}

const trackerStatuses: ReadonlyArray<TrackerStatus> = ['in_progress', 'in_review'];

function githubPlace(
  value: Record<string, unknown>,
  name: string,
): { host: string; owner: string; repo: string } | string {
  if (value['kind'] !== 'github') {
    return `FACTORY.json ${name}.kind must be github; it is the only ${name} adapter so far.`;
  }
  const owner = readString(value, 'owner');
  const repo = readString(value, 'repo');
  if (owner === null || repo === null) {
    return `FACTORY.json ${name} needs owner and repo.`;
  }
  return { host: readString(value, 'host') ?? 'github.com', owner, repo };
}

function stringArray(value: unknown): Array<string> | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
    ? value
    : null;
}

// A message on error.
function readTracker(value: unknown): TrackerConfig | null | string {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return 'FACTORY.json tracker must be an object.';
  }
  const place = githubPlace(value, 'tracker');
  if (typeof place === 'string') {
    return place;
  }
  const backlogValue = value['backlog'] ?? {};
  if (!isRecord(backlogValue)) {
    return 'FACTORY.json tracker.backlog must be an object.';
  }
  const labels = backlogValue['labels'] === undefined ? [] : stringArray(backlogValue['labels']);
  const milestone = backlogValue['milestone'] ?? null;
  if (labels === null || (milestone !== null && typeof milestone !== 'string')) {
    return 'FACTORY.json tracker.backlog takes labels (an array of names) and a milestone name.';
  }
  const statusValue = value['status'] ?? {};
  if (!isRecord(statusValue)) {
    return 'FACTORY.json tracker.status must be an object.';
  }
  const status: TrackerConfig['status'] = {};
  for (const [name, mapping] of Object.entries(statusValue)) {
    const known = trackerStatuses.find((item) => item === name);
    const label = isRecord(mapping) ? readString(mapping, 'label') : null;
    if (known === undefined || label === null) {
      return `FACTORY.json tracker.status maps in_progress and in_review to { "label": "<name>" }.`;
    }
    status[known] = { label };
  }
  return { ...place, backlog: { labels, milestone }, kind: 'github', status };
}

function readCodeHost(value: unknown): CodeHostConfig | null | string {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return 'FACTORY.json codeHost must be an object.';
  }
  const place = githubPlace(value, 'codeHost');
  if (typeof place === 'string') {
    return place;
  }
  const pullRequests = value['pullRequests'] ?? true;
  if (typeof pullRequests !== 'boolean') {
    return 'FACTORY.json codeHost.pullRequests must be true or false.';
  }
  const secret = value['webhookSecretEnv'];
  if (secret !== undefined && (typeof secret !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(secret))) {
    return 'FACTORY.json codeHost.webhookSecretEnv must name an environment variable.';
  }
  return { ...place, kind: 'github', pullRequests, webhookSecretEnv: secret ?? null };
}

// Pull requests are on unless the code host turns them off.
export function pullRequestsAllowed(config: FactoryConfig): boolean {
  return config.codeHost?.pullRequests ?? true;
}

function readServer(value: unknown): FactoryConfig['server'] | null {
  if (value === undefined) {
    return { ...DEFAULT_SERVER };
  }
  if (!isRecord(value)) {
    return null;
  }
  const host = value['host'] === undefined ? DEFAULT_SERVER.host : readString(value, 'host');
  const port = value['port'] ?? DEFAULT_SERVER.port;
  if (host === null || typeof port !== 'number' || !Number.isInteger(port)) {
    return null;
  }
  return port >= 1 && port <= 65_535 ? { host, port } : null;
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
