import type {
  ReconcileObservation,
  RunId,
  RunPurpose,
  SessionId,
  TerminalOutcome,
} from '../domain.ts';

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
  stage: 'plan' | 'work' | 'review' | 'wrapup';
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

export type FactorySubagentRuntime = {
  interrupt: (input: { paneId: string; runId: RunId }) => Promise<void>;
  launch: (spec: LaunchSpec) => Promise<RunStarted>;
  observe: (run: ActiveWatch, handler: (event: TerminalOutcome) => void) => () => void;
  reconcile: (
    runs: Array<ActiveWatch>,
  ) => Promise<Array<{ observation: ReconcileObservation; runId: RunId }>>;
  resume: (spec: LaunchSpec) => Promise<RunStarted>;
};
