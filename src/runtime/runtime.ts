import type {
  ReconcileObservation,
  RunId,
  RunPurpose,
  SessionId,
  StageName,
  TerminalOutcome,
} from '../domain.ts';

// The Herdr tab a ticket's panes open in: one per ticket, named after it.
export type TicketTab = { key: string; label: string };

// Where an agent's project configuration comes from. `worktree`: Pi's own
// discovery from its working directory, of the context files (AGENTS.md,
// CLAUDE.md) and, when the project is trusted, of `.pi` prompt files,
// extensions, skills, and settings. `base`: none of the worktree's. Pi treats
// the project as untrusted, and gets the files the controller wrote from the
// ticket's base commit, such as the reviewer's rules, and the stage's skill by
// name from the factory's own skills.
export type ProjectConfig =
  | { kind: 'worktree' }
  | {
      appendSystemPrompt: Array<string>;
      kind: 'base';
      skill: string;
      systemPrompt: string | null;
    };

export type LaunchSpec = {
  cwd: string;
  mode: 'launch' | 'resume';
  model: string;
  paneName: string;
  previousPaneId: string | null;
  projectConfig: ProjectConfig;
  prompt: string;
  purpose: RunPurpose;
  runId: RunId;
  sessionFile: string;
  sessionId: SessionId;
  stage: StageName;
  // Without a tab, the pane opens next to the host's own pane.
  tab?: TicketTab | null;
  taskLabel: string | null;
  thinking: string;
  tools: string;
};

export type RunStarted = {
  paneId: string;
  paneName: string;
  piSessionId: string;
  runId: RunId;
  sessionFile: string;
};

export type ActiveWatch = {
  paneId: string | null;
  runId: RunId;
  sessionFile: string | null;
};

// A human-facing pane that runs no model turn: the finished wrap-up session
// reopened for reading, or the ticket's diff in Hunk or Fresh. `notes` is
// Hunk's agent-context file for the diff, when there is one.
export type PaneSpec = {
  cwd: string;
  // FACTORY_WORKTREE for the pane's processes, such as `handoff:<action id>`:
  // the stray sweep leaves it alone, and it tells this pane from another that
  // Herdr later gives the same id.
  marker: string;
  name: string;
  scriptFile: string;
  tab?: TicketTab | null;
  target:
    | { file: string; kind: 'diff'; notes: string | null }
    // The session's own model and thinking: without them Pi restores the
    // session's model only when its provider has stored credentials.
    | { kind: 'session'; model: string; sessionFile: string; thinking: string };
};

export type FactorySubagentRuntime = {
  // Closes a pane, if the runtime can; a pane already gone is not an error.
  closePane?: (paneId: string) => Promise<void>;
  // Closes a finished ticket's tab, if the runtime opened one.
  closeTab?: (key: string) => Promise<void>;
  interrupt: (input: { paneId: string; runId: RunId }) => Promise<void>;
  launch: (spec: LaunchSpec) => Promise<RunStarted>;
  observe: (run: ActiveWatch, handler: (event: TerminalOutcome) => void) => () => void;
  openPane: (spec: PaneSpec) => Promise<{ paneId: string }>;
  // Whether a process in the pane carries `marker` as FACTORY_WORKTREE: false
  // when the pane is gone, or Herdr gave its id to another pane.
  paneCarries?: (paneId: string, marker: string) => Promise<boolean>;
  reconcile: (
    runs: Array<ActiveWatch>,
  ) => Promise<Array<{ observation: ReconcileObservation; runId: RunId }>>;
  resume: (spec: LaunchSpec) => Promise<RunStarted>;
};
