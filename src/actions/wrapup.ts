import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { finishLeasedAction, ticketTab } from '../controller/store.ts';
import type { ActionRecord, FactorySnapshot, IdSource, RunId } from '../domain.ts';
import type { CodeHost } from '../ports/code-host.ts';
import type { FactorySubagentRuntime } from '../runtime/runtime.ts';
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
        const collected = collectWorkDiff(action.cwd);
        const file = `${sessionFile}.diff`;
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, 'diff' in collected ? collected.diff : `# ${collected.message}\n`);
        await input.runtime.openPane({
          cwd: action.cwd,
          name: action.name,
          scriptFile: `${sessionFile}.diff.sh`,
          tab: ticketTab(snapshot),
          target: { file, kind: 'diff' },
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
