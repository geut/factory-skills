import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { finishLeasedAction, handoffPanes, ticketTab } from '../controller/store.ts';
import type { ActionRecord, ExecutionId, FactorySnapshot, IdSource, RunId } from '../domain.ts';
import type { CodeHost } from '../ports/code-host.ts';
import type { FactorySubagentRuntime } from '../runtime/runtime.ts';
import { runOutput } from '../stages/output.ts';
import { latestReviews } from '../stages/review/parse.ts';
import { diffNotes } from '../stages/wrapup/notes.ts';
import { collectWorkDiff } from '../validation/work.ts';
import type { PullRequestLookup } from '../validation/wrapup.ts';

type Context = { db: DatabaseSync; ids: IdSource; now: () => string };

// Wrap-up validation's view of the pull request at the handoff URL. A missing
// pull request is a validation failure; any other code host error is an
// infrastructure error.
export function pullRequestLookup(codeHost: CodeHost): PullRequestLookup {
  return (url) => codeHost.pullRequest(url) ?? { missing: true };
}

// The marker a handoff pane's processes carry, as FACTORY_WORKTREE.
export function handoffMarker(actionId: string): string {
  return `handoff:${actionId}`;
}

// Closes the execution's earlier handoff panes of `kinds` that are still open,
// so a feedback round's handoff replaces them instead of adding more, and the
// round's wrap-up is the only Pi with the wrap-up session open. A recorded pane
// is closed only while a process in it carries that pane's own marker: Herdr
// can give a closed pane's id to another pane, which is left alone.
export async function closeHandoffPanes(
  input: { db: DatabaseSync; runtime: FactorySubagentRuntime },
  executionId: ExecutionId,
  kinds: ReadonlyArray<'open_diff' | 'open_pane'>,
): Promise<Array<string>> {
  const { runtime } = input;
  if (runtime.closePane === undefined || runtime.paneCarries === undefined) {
    return [];
  }
  const closed: Array<string> = [];
  for (const pane of handoffPanes(input.db, executionId)) {
    if (!kinds.includes(pane.kind)) {
      continue;
    }
    // Called on the runtime, which may be a class: its methods need `this`.
    const ours = await runtime
      .paneCarries(pane.paneId, handoffMarker(pane.actionId))
      .catch(() => false);
    if (ours) {
      await runtime.closePane(pane.paneId).catch(() => undefined);
      closed.push(pane.paneId);
    }
  }
  return closed;
}

// Opens a handoff pane. A failure retries here and never fails the handoff.
export async function openHandoffPane(
  input: Context & { runtime: FactorySubagentRuntime },
  action: Extract<ActionRecord, { kind: 'open_diff' | 'open_pane' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const run = snapshot.runs.find((item) => item.id === action.runId) ?? null;
  const session =
    run === null ? null : (snapshot.sessions.find((item) => item.id === run.sessionId) ?? null);
  const sessionFile = session?.sessionFile ?? null;
  if (session === null || sessionFile === null) {
    finishLeasedAction(
      input.db,
      action.id,
      input.now(),
      'failed',
      'The wrap-up session file is missing.',
    );
    return null;
  }
  const worktree = snapshot.execution.worktreePath ?? snapshot.execution.policy.codeRoot;
  // A feedback round's handoff replaces the panes of the one before.
  await closeHandoffPanes(input, snapshot.execution.id, [action.kind]);
  let lastError = 'herdr pane open failed';
  let opened: { paneId: string } | null = null;
  for (let attempt = 1; attempt <= action.maxAttempts; attempt += 1) {
    try {
      if (action.kind === 'open_diff') {
        // Wrap-up may have committed the work, so the diff runs from the
        // commit the worktree started at.
        const collected = collectWorkDiff(action.cwd, snapshot.execution.worktreeBaseSha ?? 'HEAD');
        const file = `${sessionFile}.diff`;
        mkdirSync(path.dirname(file), { recursive: true });
        const patch = 'diff' in collected ? collected.diff : `# ${collected.message}\n`;
        writeFileSync(file, patch);
        const notes = diffNotes(
          patch,
          run === null ? '' : runOutput(run),
          latestReviews(snapshot).flatMap(({ result, taskId }) =>
            result.findings.map((finding) => ({ finding, taskId })),
          ),
        );
        const notesFile = notes === null ? null : `${sessionFile}.notes.json`;
        if (notesFile !== null) {
          writeFileSync(notesFile, `${JSON.stringify(notes, null, 2)}\n`);
        }
        opened = await input.runtime.openPane({
          cwd: action.cwd,
          marker: handoffMarker(action.id),
          name: action.name,
          scriptFile: `${sessionFile}.diff.sh`,
          tab: ticketTab(snapshot),
          target: { file, kind: 'diff', notes: notesFile },
        });
      } else {
        opened = await input.runtime.openPane({
          cwd: worktree,
          marker: handoffMarker(action.id),
          name: action.name,
          scriptFile: `${sessionFile}.inspect.sh`,
          tab: ticketTab(snapshot),
          target: {
            kind: 'session',
            model: session.model,
            sessionFile,
            thinking: session.thinking,
          },
        });
      }
      finishLeasedAction(input.db, action.id, input.now(), 'succeeded', null, {
        paneId: opened.paneId,
      });
      return null;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  finishLeasedAction(input.db, action.id, input.now(), 'failed', lastError);
  return null;
}
