import type { FactorySnapshot, RunRecord } from '../domain.ts';

// The agent's raw response for a finished run.
export function runOutput(run: RunRecord): string {
  if (run.resultJson === null) {
    return '';
  }
  try {
    const parsed: unknown = JSON.parse(run.resultJson);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'output' in parsed &&
      typeof parsed.output === 'string'
    ) {
      return parsed.output;
    }
    return run.resultJson;
  } catch {
    return run.resultJson;
  }
}

// What the task's worker last said, across all its work sessions: the reply
// of its latest round, and what it said in that round's corrections. A
// round's reply can be empty (the agent finished without writing the
// template); the last reply with text stands in, marked.
export function workerSummary(snapshot: FactorySnapshot, taskId: string): string {
  const sessions = new Set(
    snapshot.sessions
      .filter((item) => item.stage === 'work' && item.taskId === taskId)
      .map((item) => item.id),
  );
  const finished = snapshot.runs.filter(
    (item) => sessions.has(item.sessionId) && item.terminalKind === 'subagent_done',
  );
  const start = finished.findLastIndex((item) => item.purpose !== 'validation_correction');
  if (start === -1) {
    return '';
  }
  const [round, ...corrections] = finished.slice(start).map((item) => runOutput(item).trim());
  const earlier = finished.slice(0, start).findLast((item) => runOutput(item).trim().length > 0);
  const reply =
    round !== undefined && round.length > 0
      ? round
      : earlier === undefined
        ? ''
        : `${runOutput(earlier).trim()}\n\n(The worker's latest reply was empty; this is its last reply with text.)`;
  return [reply, ...corrections].filter((text) => text.length > 0).join('\n\n');
}
