import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { StageSettings } from './stages/definition.ts';
import { stageLimits, stages } from './stages/index.ts';
import {
  isTitleTemplate,
  titleTemplateProblem,
  type TitleTemplate,
} from './stages/wrapup/title.ts';

export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
// Installing dependencies takes longer than a check.
export const DEFAULT_SETUP_TIMEOUT_MS = 600_000;
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

// Which tracker updates the factory may write besides statuses, which are
// written only when mapped. Both default to on.
export type TrackerUpdates = {
  // Ticking the issue's checklist items at handoff. Off, the met items are
  // listed in the handoff comment instead.
  checklist: boolean;
  // Comments on start, on a pause for a person, at handoff, and on cancel.
  comments: boolean;
};

// GitHub Issues as the tracker.
export type GithubTrackerConfig = {
  // Which open issues the backlog shows: GitHub filters by labels and milestone.
  backlog: { labels: Array<string>; milestone: string | null };
  host: string;
  kind: 'github';
  owner: string;
  repo: string;
  // How each factory status shows on the issue: a label. An unmapped status is
  // not written.
  status: Partial<Record<TrackerStatus, { label: string }>>;
  updates: TrackerUpdates;
};

// Linear's kinds of workflow state, in workflow order.
export const LINEAR_STATE_TYPES = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
  'duplicate',
] as const;
export type LinearStateType = (typeof LINEAR_STATE_TYPES)[number];

// Linear as the tracker. Every name here is one the workspace already has;
// the server checks them at startup.
export type LinearTrackerConfig = {
  // The environment variable that holds a personal API key.
  apiKeyEnv: string;
  // Which open issues of the team the backlog shows: all of these labels, the
  // project, and issues whose workflow state is one of these types.
  backlog: { labels: Array<string>; project: string | null; states: Array<LinearStateType> };
  kind: 'linear';
  // How each factory status shows on the issue: a workflow state of the
  // issue's team, by name. An unmapped status is not written.
  status: Partial<Record<TrackerStatus, { state: string }>>;
  // The key of the team whose issues are the backlog, such as `ENG`.
  team: string;
  updates: TrackerUpdates;
};

// Where issues and the backlog live. Each tracker kind has its own place,
// backlog, and status settings.
export type TrackerConfig = GithubTrackerConfig | LinearTrackerConfig;

export const DEFAULT_LINEAR_API_KEY_ENV = 'LINEAR_API_KEY';
export const DEFAULT_LINEAR_BACKLOG_STATES: Array<LinearStateType> = ['backlog', 'unstarted'];

export const DEFAULT_TRACKER_UPDATES: TrackerUpdates = { checklist: true, comments: true };

// Where the repository and its pull requests live.
export type CodeHostConfig = {
  // Whether wrap-up opens a new pull request as a draft. It never converts an
  // existing one.
  draft: boolean;
  host: string;
  kind: 'github';
  owner: string;
  // Whether wrap-up may push the branch and open a pull request.
  pullRequests: boolean;
  // The pull request title, with {ref} and {summary}; null keeps the default.
  pullRequestTitle: TitleTemplate | null;
  repo: string;
  // How often the server checks the pull requests of tickets in handoff.
  syncMinutes: number;
  // The environment variable that holds the webhook secret, if any.
  webhookSecretEnv: string | null;
};

export const DEFAULT_SYNC_MINUTES = 10;

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
  // Commands that prepare each new worktree, such as installing dependencies.
  worktree: { setup: Array<WorkCommand> };
};

// `wrapup.generated` lists path prefixes or `*` globs of generated artifacts
// the wrap-up agent may refresh, such as `docs/api/` or `*.snap`. `qa.commands`
// run after QA's own commands so the tests QA wrote meet the project's bar;
// without them, they are `work.commands`.
export type Validation = {
  qa: { commands: Array<WorkCommand> };
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

function readTimeout(value: unknown, fallback = DEFAULT_COMMAND_TIMEOUT_MS): number | null {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

// A list of { name, argv, timeoutMs? } commands; null when any is malformed.
function commandList(value: unknown, fallbackTimeout: number): Array<WorkCommand> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const parsed: Array<WorkCommand> = [];
  for (const command of value) {
    if (!isRecord(command)) {
      return null;
    }
    const name = readString(command, 'name');
    const timeoutMs = readTimeout(command['timeoutMs'], fallbackTimeout);
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

// `validation.<stage>.commands`: undefined when not listed, null when malformed.
function readCommands(value: unknown, stage: 'qa' | 'work'): Array<WorkCommand> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }
  const commands = value[stage] ?? {};
  if (!isRecord(commands)) {
    return null;
  }
  return commands['commands'] === undefined
    ? undefined
    : commandList(commands['commands'], DEFAULT_COMMAND_TIMEOUT_MS);
}

// `worktree.setup` runs once in each new worktree, before its first agent.
function readWorktree(value: unknown): FactoryConfig['worktree'] | null {
  if (value === undefined) {
    return { setup: [] };
  }
  if (!isRecord(value)) {
    return null;
  }
  const setup = commandList(value['setup'] ?? [], DEFAULT_SETUP_TIMEOUT_MS);
  return setup === null ? null : { setup };
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
  const workCommands = readCommands(value['validation'], 'work');
  if (workCommands === null) {
    return {
      kind: 'error',
      message:
        'FACTORY.json validation.work.commands must be objects with a name, an argv array, and an optional timeoutMs.',
    };
  }
  const commands = workCommands ?? [];
  const qaCommands = readCommands(value['validation'], 'qa');
  if (qaCommands === null) {
    return {
      kind: 'error',
      message:
        'FACTORY.json validation.qa.commands must be objects with a name, an argv array, and an optional timeoutMs.',
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

  const worktree = readWorktree(value['worktree']);
  if (worktree === null) {
    return {
      kind: 'error',
      message:
        'FACTORY.json worktree.setup must be commands with a name, an argv array, and an optional timeoutMs.',
    };
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
      validation: {
        qa: { commands: qaCommands ?? commands },
        work: { commands },
        wrapup: { generated },
      },
      worktree,
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
  if (value['kind'] === 'linear') {
    return readLinearTracker(value);
  }
  if (value['kind'] !== 'github') {
    return 'FACTORY.json tracker.kind must be github or linear.';
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
  const status: GithubTrackerConfig['status'] = {};
  for (const [name, mapping] of Object.entries(statusValue)) {
    const known = trackerStatuses.find((item) => item === name);
    const label = isRecord(mapping) ? readString(mapping, 'label') : null;
    if (known === undefined || label === null) {
      return `FACTORY.json tracker.status maps in_progress and in_review to { "label": "<name>" }.`;
    }
    status[known] = { label };
  }
  const updates = readTrackerUpdates(value['updates']);
  if (typeof updates === 'string') {
    return updates;
  }
  return { ...place, backlog: { labels, milestone }, kind: 'github', status, updates };
}

// The shape of an environment variable name, for settings that name one.
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

// A message on error.
function readLinearTracker(value: Record<string, unknown>): LinearTrackerConfig | string {
  const team = readString(value, 'team');
  if (team === null) {
    return 'FACTORY.json tracker needs team, the key of a Linear team such as "ENG".';
  }
  const apiKeyEnv = value['apiKeyEnv'] ?? DEFAULT_LINEAR_API_KEY_ENV;
  if (typeof apiKeyEnv !== 'string' || !ENV_NAME.test(apiKeyEnv)) {
    return 'FACTORY.json tracker.apiKeyEnv must name an environment variable.';
  }
  const backlogValue = value['backlog'] ?? {};
  if (!isRecord(backlogValue)) {
    return 'FACTORY.json tracker.backlog must be an object.';
  }
  const labels = backlogValue['labels'] === undefined ? [] : stringArray(backlogValue['labels']);
  const project = backlogValue['project'] ?? null;
  const states =
    backlogValue['states'] === undefined
      ? DEFAULT_LINEAR_BACKLOG_STATES
      : stringArray(backlogValue['states']);
  const knownStates = states?.every((state) =>
    (LINEAR_STATE_TYPES as ReadonlyArray<string>).includes(state),
  );
  if (
    labels === null ||
    (project !== null && typeof project !== 'string') ||
    states === null ||
    states.length === 0 ||
    !knownStates
  ) {
    return `FACTORY.json tracker.backlog takes labels (an array of names), a project name, and states (workflow state types: ${LINEAR_STATE_TYPES.join(', ')}).`;
  }
  const statusValue = value['status'] ?? {};
  if (!isRecord(statusValue)) {
    return 'FACTORY.json tracker.status must be an object.';
  }
  const status: LinearTrackerConfig['status'] = {};
  for (const [name, mapping] of Object.entries(statusValue)) {
    const known = trackerStatuses.find((item) => item === name);
    const state = isRecord(mapping) ? readString(mapping, 'state') : null;
    if (known === undefined || state === null) {
      return `FACTORY.json tracker.status maps in_progress and in_review to { "state": "<workflow state name>" }.`;
    }
    status[known] = { state };
  }
  const updates = readTrackerUpdates(value['updates']);
  if (typeof updates === 'string') {
    return updates;
  }
  return {
    apiKeyEnv,
    backlog: { labels, project, states: states as Array<LinearStateType> },
    kind: 'linear',
    status,
    team,
    updates,
  };
}

// A message on error.
function readTrackerUpdates(value: unknown): TrackerUpdates | string {
  if (value === undefined) {
    return DEFAULT_TRACKER_UPDATES;
  }
  const message = 'FACTORY.json tracker.updates takes comments and checklist, each true or false.';
  if (!isRecord(value)) {
    return message;
  }
  const updates = { ...DEFAULT_TRACKER_UPDATES };
  for (const [name, on] of Object.entries(value)) {
    if ((name !== 'comments' && name !== 'checklist') || typeof on !== 'boolean') {
      return message;
    }
    updates[name] = on;
  }
  return updates;
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
  const syncMinutes = value['syncMinutes'] ?? DEFAULT_SYNC_MINUTES;
  if (typeof syncMinutes !== 'number' || !(syncMinutes > 0)) {
    return 'FACTORY.json codeHost.syncMinutes must be a positive number.';
  }
  const secret = value['webhookSecretEnv'];
  if (secret !== undefined && (typeof secret !== 'string' || !ENV_NAME.test(secret))) {
    return 'FACTORY.json codeHost.webhookSecretEnv must name an environment variable.';
  }
  const title = value['pullRequestTitle'] ?? null;
  if (title !== null && typeof title !== 'string') {
    return 'FACTORY.json codeHost.pullRequestTitle must be a string such as "{ref} | {summary}".';
  }
  if (title !== null && !isTitleTemplate(title)) {
    return `FACTORY.json codeHost.pullRequestTitle is not a title template: ${titleTemplateProblem(title) ?? ''}`;
  }
  const draft = value['draft'] ?? false;
  if (typeof draft !== 'boolean') {
    return 'FACTORY.json codeHost.draft must be true or false.';
  }
  return {
    ...place,
    draft,
    kind: 'github',
    pullRequests,
    pullRequestTitle: title,
    syncMinutes,
    webhookSecretEnv: secret ?? null,
  };
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
