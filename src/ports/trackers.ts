import type { TrackerConfig, TrackerUpdates } from '../config.ts';
import { createGithubTracker, githubCliClient, type GithubClient } from './github.ts';
import type { Tracker } from './tracker.ts';

// A configured tracker and the updates FACTORY.json lets the factory write to it.
export type ConfiguredTracker = { tracker: Tracker; updates: TrackerUpdates };

// The clients each tracker adapter talks through. Tests pass stand-ins.
export type TrackerClients = { github: GithubClient };

export function defaultTrackerClients(): TrackerClients {
  return { github: githubCliClient() };
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
  }
}

// The tracker kind tickets resolve through: the configured one, or GitHub.
export function trackerKindOf(config: TrackerConfig | null): string {
  return config?.kind ?? 'github';
}
