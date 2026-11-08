import { DEFAULT_LINEAR_API_KEY_ENV, type TrackerConfig, type TrackerUpdates } from '../config.ts';
import { createGithubTracker, type GithubClient } from './github.ts';
import {
  createLinearTracker,
  linearSdkApi,
  type LinearApi,
  type LinearInventory,
} from './linear.ts';
import type { Tracker } from './tracker.ts';

// A configured tracker and the updates FACTORY.json lets the factory write to it.
export type ConfiguredTracker = { tracker: Tracker; updates: TrackerUpdates };

// The clients each tracker adapter talks through. Tests pass stand-ins.
export type TrackerClients = {
  github: GithubClient;
  // Linear, with the API key in the environment variable of this name.
  linear: (apiKeyEnv: string) => LinearApi;
};

// Linear through the SDK, with the API key from `env`.
export function linearFromEnv(env: NodeJS.ProcessEnv): TrackerClients['linear'] {
  return (apiKeyEnv) => linearSdkApi(env[apiKeyEnv] ?? '');
}

// The one place a tracker is built from FACTORY.json, by its kind. Without a
// tracker, GitHub still resolves full issue refs (a URL or owner/repo#n), as it
// always has; it just has no backlog.
export function createTracker(config: TrackerConfig | null, clients: TrackerClients): Tracker {
  if (config === null) {
    return createGithubTracker(null, clients.github);
  }
  switch (config.kind) {
    case 'github':
      return createGithubTracker(config, clients.github);
    case 'linear':
      return createLinearTracker(config, clients.linear(config.apiKeyEnv));
  }
}

// The tracker kind tickets resolve through: the configured one, or GitHub.
export function trackerKindOf(config: TrackerConfig | null): string {
  return config?.kind ?? 'github';
}

export type InventoryResult =
  | { inventory: LinearInventory; kind: 'ok' }
  | { kind: 'error'; message: string; reason: 'no_api_key' | 'tracker_unavailable' };

// What a Linear workspace has: teams with their workflow states and labels,
// workspace labels, and projects. The API key is the configured Linear
// tracker's, else LINEAR_API_KEY, so the settings can be written before the
// tracker is.
export async function linearInventory(
  config: TrackerConfig | null,
  env: NodeJS.ProcessEnv,
  linear: TrackerClients['linear'],
): Promise<InventoryResult> {
  const apiKeyEnv = config?.kind === 'linear' ? config.apiKeyEnv : DEFAULT_LINEAR_API_KEY_ENV;
  if ((env[apiKeyEnv] ?? '').length === 0) {
    return {
      kind: 'error',
      message: `Set ${apiKeyEnv} to a Linear personal API key.`,
      reason: 'no_api_key',
    };
  }
  try {
    return { inventory: await linear(apiKeyEnv).inventory(), kind: 'ok' };
  } catch (error: unknown) {
    return {
      kind: 'error',
      message: `Linear: ${error instanceof Error ? error.message : String(error)}`,
      reason: 'tracker_unavailable',
    };
  }
}
