import {
  zeroUsage,
  type ReconcileObservation,
  type RunId,
  type TerminalOutcome,
  type UsageTotals,
} from '../domain.ts';
import type {
  ActiveWatch,
  FactorySubagentRuntime,
  LaunchSpec,
  PaneSpec,
  RunStarted,
} from './runtime.ts';

type Tracked = {
  alive: boolean;
  spec: LaunchSpec;
  started: RunStarted;
  terminal: TerminalOutcome | null;
};

export class FakeRuntime implements FactorySubagentRuntime {
  readonly launches: Array<LaunchSpec> = [];
  readonly panes: Array<PaneSpec> = [];
  failNext = false;
  paneFailures = 0;
  failuresRemaining = 0;
  private readonly tracked = new Map<string, Tracked>();
  private readonly watchers = new Map<string, (event: TerminalOutcome) => void>();

  async launch(spec: LaunchSpec): Promise<RunStarted> {
    return this.start(spec);
  }

  async resume(spec: LaunchSpec): Promise<RunStarted> {
    return this.start(spec);
  }

  async openPane(spec: PaneSpec): Promise<{ paneId: string }> {
    if (this.paneFailures > 0) {
      this.paneFailures -= 1;
      throw new Error('herdr pane open failed');
    }
    this.panes.push(spec);
    return { paneId: `pane-${spec.name}` };
  }

  async interrupt(): Promise<void> {
    return undefined;
  }

  observe(run: ActiveWatch, handler: (event: TerminalOutcome) => void): () => void {
    if (this.watchers.has(run.runId)) {
      return () => undefined;
    }
    this.watchers.set(run.runId, handler);
    // Like an exit file on disk, a terminal that landed before the watch
    // still reaches a late observer.
    const terminal = this.tracked.get(run.runId)?.terminal ?? null;
    if (terminal !== null) {
      queueMicrotask(() => {
        handler(terminal);
      });
    }
    return () => {
      this.watchers.delete(run.runId);
    };
  }

  async reconcile(
    runs: Array<ActiveWatch>,
  ): Promise<Array<{ observation: ReconcileObservation; runId: RunId }>> {
    return runs.map((run) => {
      const tracked = this.tracked.get(run.runId);
      if (tracked === undefined) {
        return { observation: { kind: 'missing' }, runId: run.runId };
      }
      if (tracked.alive) {
        return {
          observation: {
            kind: 'still_running',
            paneId: tracked.started.paneId,
            piSessionId: tracked.started.piSessionId,
            sessionFile: tracked.started.sessionFile,
          },
          runId: run.runId,
        };
      }
      return {
        observation: {
          kind: 'terminal',
          terminal: tracked.terminal ?? { kind: 'gap_exit', message: 'missing terminal' },
        },
        runId: run.runId,
      };
    });
  }

  emit(runId: RunId, terminal: TerminalOutcome): void {
    const tracked = this.tracked.get(runId);
    if (tracked !== undefined) {
      tracked.alive = false;
      tracked.terminal = terminal;
    }
    this.watchers.get(runId)?.(terminal);
  }

  private async start(spec: LaunchSpec): Promise<RunStarted> {
    if (this.failNext || this.failuresRemaining > 0) {
      this.failNext = false;
      if (this.failuresRemaining > 0) {
        this.failuresRemaining -= 1;
      }
      throw new Error('herdr launch failed');
    }
    const started: RunStarted = {
      paneId:
        spec.mode === 'resume' && spec.previousPaneId !== null
          ? spec.previousPaneId
          : `pane-${spec.runId}`,
      paneName: spec.paneName,
      piSessionId: `pi-${spec.sessionId}`,
      runId: spec.runId,
      sessionFile: spec.sessionFile,
    };
    this.launches.push(spec);
    this.tracked.set(spec.runId, { alive: true, spec, started, terminal: null });
    return started;
  }
}

export function sampleUsage(total = 10): UsageTotals {
  return { ...zeroUsage(), inputTokens: total, outputTokens: total, totalTokens: total * 2 };
}
