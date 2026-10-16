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

export type LaunchSpec = {
  cwd: string;
  mode: 'launch' | 'resume';
  model: string;
  paneName: string;
  previousPaneId: string | null;
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
// reopened for reading, or the worktree diff in Fresh.
export type PaneSpec = {
  cwd: string;
  name: string;
  scriptFile: string;
  tab?: TicketTab | null;
  target: { file: string; kind: 'diff' } | { kind: 'session'; sessionFile: string };
};

export type FactorySubagentRuntime = {
  // Closes a finished ticket's tab, if the runtime opened one.
  closeTab?: (key: string) => Promise<void>;
  interrupt: (input: { paneId: string; runId: RunId }) => Promise<void>;
  launch: (spec: LaunchSpec) => Promise<RunStarted>;
  observe: (run: ActiveWatch, handler: (event: TerminalOutcome) => void) => () => void;
  openPane: (spec: PaneSpec) => Promise<{ paneId: string }>;
  reconcile: (
    runs: Array<ActiveWatch>,
  ) => Promise<Array<{ observation: ReconcileObservation; runId: RunId }>>;
  resume: (spec: LaunchSpec) => Promise<RunStarted>;
};
