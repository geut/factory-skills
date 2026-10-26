import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { finishLeasedAction, ticketTab } from '../controller/store.ts';
import type { ActionRecord, FactorySnapshot, IdSource, RunId } from '../domain.ts';
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
  if (sessionFile === null) {
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
  let lastError = 'herdr pane open failed';
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
        await input.runtime.openPane({
          cwd: action.cwd,
          name: action.name,
          scriptFile: `${sessionFile}.diff.sh`,
          tab: ticketTab(snapshot),
          target: { file, kind: 'diff', notes: notesFile },
        });
      } else {
        await input.runtime.openPane({
          cwd: worktree,
          name: action.name,
          scriptFile: `${sessionFile}.inspect.sh`,
          tab: ticketTab(snapshot),
          target: { kind: 'session', sessionFile },
        });
      }
      finishLeasedAction(input.db, action.id, input.now(), 'succeeded', null);
      return null;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  finishLeasedAction(input.db, action.id, input.now(), 'failed', lastError);
  return null;
}
