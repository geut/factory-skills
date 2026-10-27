import type { DatabaseSync } from 'node:sqlite';
import { factoryIdentity } from '../controller/facts.ts';
import { keyOfFactoryDir } from '../controller/keys.ts';
import type { RunPurpose, StageName } from '../domain.ts';

// Fact rows for factory stats, `stats.v1`, computed on every read from the raw
// tables (status history, runs, usage, pull requests). Nothing is stored
// pre-aggregated, so changing a definition here recomputes all history. The
// definitions are documented in docs/stats-v1.md.

export const STATS_DEFINITIONS = 'stats.v1';

// What happened to a ticket: merged; abandoned (its pull request was closed
// without merging); cancelled (by a person); unknown (finished, but no pull
// request outcome was seen); or open (not finished yet).
export type Outcome = 'abandoned' | 'cancelled' | 'merged' | 'open' | 'unknown';

const WAITING = new Set(['waiting_for_user', 'paused', 'resume_failed']);
const TASK_STAGES = new Set(['work', 'qa', 'review']);
const INFRASTRUCTURE = new Set(['launch_failed', 'crashed', 'pane_killed', 'gap_exit']);

export type RunFacts = {
  agentMs: number | null;
  costUsd: number;
  execution: string;
  infrastructureLost: boolean;
  model: string;
  // Whether validation accepted this run's output.
  passed: boolean | null;
  purpose: RunPurpose;
  // For a return to work, the stage that sent the task back.
  returnedFrom: StageName | null;
  round: number;
  run: string;
  // `model` plus thinking level, such as `anthropic/claude · high`.
  setup: string;
  stage: StageName;
  task: string | null;
  thinking: string;
  tokens: number;
} & TokenCategories;

// Token usage by category, null when the usage was never recorded. See
// docs/stats-v1.md for how they relate to `tokens`.
export type TokenCategories = {
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
};

export type TicketFacts = {
  agentMs: number;
  // `plan=… work=… review=…`: the model setup of every stage that ran.
  configuration: string;
  costUsd: number;
  displayRef: string;
  execution: string;
  externalReviewRounds: {
    bot: number;
    changesRequested: number;
    commented: number;
    human: number;
    total: number;
  };
  factoryMs: number | null;
  factoryVersion: string | null;
  followUpCommits: number;
  handedOffAt: string | null;
  handoffToMergeMs: number | null;
  interventions: {
    limitPauses: number;
    manualCompletes: number;
    manualRetries: number;
    questions: number;
    replies: number;
    stops: number;
  };
  key: string;
  leadMs: number | null;
  mergedAt: string | null;
  outcome: Outcome;
  overheadMs: number | null;
  stageMs: Record<string, number>;
  startedAt: string;
  startToHandoffMs: number | null;
  tokens: number;
  waitingMs: number;
} & TokenCategories;

type Interval = {
  endedAt: string | null;
  stage: string | null;
  startedAt: string;
  status: string;
  task: string | null;
};

function ms(from: string | null, to: string | null): number | null {
  if (from === null || to === null) {
    return null;
  }
  const value = Date.parse(to) - Date.parse(from);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function length(interval: Interval, now: string): number {
  return ms(interval.startedAt, interval.endedAt ?? now) ?? 0;
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function setupOf(model: string, thinking: string): string {
  return thinking.length > 0 ? `${model} · ${thinking}` : model;
}

// The token categories of a usage row (`tokens_input` and so on), or nulls when
// it has no `tokens_total`: no usage was recorded.
function tokenCategories(row: Record<string, unknown>): TokenCategories {
  const known = row['tokens_total'] !== null && row['tokens_total'] !== undefined;
  const count = (column: string) => (known ? Number(row[column] ?? 0) : null);
  return {
    tokensCacheRead: count('tokens_cache_read'),
    tokensCacheWrite: count('tokens_cache_write'),
    tokensInput: count('tokens_input'),
    tokensOutput: count('tokens_output'),
  };
}

export function runFacts(db: DatabaseSync, executions: Array<string>): Array<RunFacts> {
  if (executions.length === 0) {
    return [];
  }
  const marks = executions.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT r.id, r.execution_id, r.purpose, r.origin, r.semantic_round, r.terminal_kind,
              r.started_at, r.ended_at, s.stage, s.task_id, s.model, s.thinking,
              u.delta_tokens_input AS tokens_input, u.delta_tokens_output AS tokens_output,
              u.delta_tokens_cache_read AS tokens_cache_read,
              u.delta_tokens_cache_write AS tokens_cache_write,
              u.delta_tokens_total AS tokens_total, u.delta_cost_usd_micros,
              (SELECT v.status FROM validation_runs AS v WHERE v.run_id = r.id
               ORDER BY v.attempt DESC LIMIT 1) AS validation
       FROM agent_runs AS r
       JOIN agent_sessions AS s ON s.id = r.session_id
       LEFT JOIN usage_snapshots AS u ON u.run_id = r.id
       WHERE r.execution_id IN (${marks})
       ORDER BY r.execution_id, s.stage, r.sequence`,
    )
    .all(...executions)
    .map((item) => {
      const model = String(item['model']);
      const thinking = String(item['thinking'] ?? '');
      const validation = str(item['validation']);
      const terminal = str(item['terminal_kind']);
      return {
        agentMs: ms(str(item['started_at']), str(item['ended_at'])),
        costUsd: Number(item['delta_cost_usd_micros'] ?? 0) / 1_000_000,
        execution: String(item['execution_id']),
        infrastructureLost:
          item['purpose'] === 'infrastructure_retry' ||
          (terminal !== null && INFRASTRUCTURE.has(terminal)),
        model,
        passed: validation === null ? null : validation === 'passed',
        purpose: String(item['purpose']) as RunPurpose,
        returnedFrom:
          item['purpose'] === 'return_to_work' ? (str(item['origin']) as StageName | null) : null,
        round: Number(item['semantic_round']),
        run: String(item['id']),
        setup: setupOf(model, thinking),
        stage: String(item['stage']) as StageName,
        task: str(item['task_id']),
        thinking,
        tokens: Number(item['tokens_total'] ?? 0),
        ...tokenCategories(item),
      };
    });
}

function outcomeOf(row: Record<string, unknown>): Outcome {
  if (row['pr_state'] === 'merged') {
    return 'merged';
  }
  if (row['status'] === 'cancelled') {
    return row['status_reason_code'] === 'pull_request_closed' ? 'abandoned' : 'cancelled';
  }
  return row['stage'] === 'done' ? 'unknown' : 'open';
}

// A commit that drew a review asking for changes, or commenting with a body,
// from anyone but the pull request's author. Counted per author kind, and as
// changes requested when any of its reviews asked for changes, else as
// commented. A commit counts once in the total.
function reviewRounds(db: DatabaseSync, execution: string, author: string | null) {
  const rows = db
    .prepare(
      `SELECT commit_sha, author, author_type, state FROM pull_request_reviews
       WHERE execution_id = ? AND commit_sha IS NOT NULL
         AND (state = 'changes_requested' OR (state = 'commented' AND has_body = 1))`,
    )
    .all(execution)
    .filter((item) => item['author'] !== author);
  const commitCount = (keep: (item: (typeof rows)[number]) => boolean) =>
    new Set(rows.filter(keep).map((item) => String(item['commit_sha']))).size;
  const total = commitCount(() => true);
  const changesRequested = commitCount((item) => item['state'] === 'changes_requested');
  return {
    bot: commitCount((item) => item['author_type'] === 'bot'),
    changesRequested,
    commented: total - changesRequested,
    human: commitCount((item) => item['author_type'] === 'human'),
    total,
  };
}

export function ticketFacts(
  db: DatabaseSync,
  input: { from?: string; now: string; to?: string },
): Array<TicketFacts> {
  const rows = db
    .prepare(
      `SELECT e.id, e.stage, e.status, e.status_reason_code, e.created_at, e.factory_dir,
              e.factory_version, t.source_payload,
              pr.state AS pr_state, pr.merged_at, pr.author AS pr_author,
              u.tokens_input, u.tokens_output, u.tokens_cache_read, u.tokens_cache_write,
              u.tokens_total, u.cost_usd_micros
       FROM ticket_executions AS e
       JOIN tickets AS t ON t.id = e.ticket_id
       LEFT JOIN pull_requests AS pr ON pr.execution_id = e.id
       LEFT JOIN execution_usage_totals AS u ON u.execution_id = e.id
       WHERE e.created_at >= ? AND e.created_at < ?
       ORDER BY e.created_at, e.id`,
    )
    .all(input.from ?? '', input.to ?? '9999');
  const runs = runFacts(
    db,
    rows.map((item) => String(item['id'])),
  );
  return rows.map((row) => {
    const execution = String(row['id']);
    const history: Array<Interval> = db
      .prepare(
        'SELECT task_id, stage, status, started_at, ended_at FROM status_history WHERE execution_id = ? ORDER BY id',
      )
      .all(execution)
      .map((item) => ({
        endedAt: str(item['ended_at']),
        stage: str(item['stage']),
        startedAt: String(item['started_at']),
        status: String(item['status']),
        task: str(item['task_id']),
      }));
    const own = history.filter((item) => item.task === null);
    const startedAt = String(row['created_at']);
    const handedOffAt = own.find((item) => item.status === 'ready_for_handoff')?.startedAt ?? null;
    const mergedAt = str(row['merged_at']);
    const waiting = own.filter((item) => WAITING.has(item.status));
    const waitingMs = waiting.reduce((sum, item) => sum + length(item, input.now), 0);
    const waitingBeforeHandoff =
      handedOffAt === null
        ? 0
        : waiting
            .filter((item) => item.startedAt < handedOffAt)
            .reduce((sum, item) => sum + (ms(item.startedAt, item.endedAt ?? handedOffAt) ?? 0), 0);
    const startToHandoffMs = ms(startedAt, handedOffAt);

    // Stage time: plan and wrap-up per ticket, work, QA, and review per task.
    const stageMs: Record<string, number> = {};
    for (const item of own) {
      if (
        item.stage === null ||
        TASK_STAGES.has(item.stage) ||
        WAITING.has(item.status) ||
        item.stage === 'done'
      ) {
        continue;
      }
      if (
        item.status === 'complete' ||
        item.status === 'cancelled' ||
        item.status === 'ready_for_handoff'
      ) {
        continue;
      }
      stageMs[item.stage] = (stageMs[item.stage] ?? 0) + length(item, input.now);
    }
    for (const item of history) {
      if (
        item.task !== null &&
        item.stage !== null &&
        TASK_STAGES.has(item.stage) &&
        item.status === 'active'
      ) {
        stageMs[item.stage] = (stageMs[item.stage] ?? 0) + length(item, input.now);
      }
    }
    const mine = runs.filter((run) => run.execution === execution);
    const agentMs = mine.reduce((sum, run) => sum + (run.agentMs ?? 0), 0);
    const stageTotal = Object.values(stageMs).reduce((sum, value) => sum + value, 0);
    const setups = new Map<string, string>();
    for (const run of mine) {
      setups.set(run.stage, run.setup);
    }
    const count = (sql: string) => Number(db.prepare(sql).get(execution)?.['n'] ?? 0);
    const handoff = handedOffAt;
    const outcome = outcomeOf(row);
    const payload: unknown = JSON.parse(String(row['source_payload'] ?? '{}'));
    const displayRef =
      typeof payload === 'object' && payload !== null && 'displayRef' in payload
        ? String(payload.displayRef)
        : '';
    const factoryDir = String(row['factory_dir']);
    return {
      agentMs,
      configuration: [...setups.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([stage, setup]) => `${stage}=${setup}`)
        .join(' '),
      costUsd: Number(row['cost_usd_micros'] ?? 0) / 1_000_000,
      displayRef,
      execution,
      externalReviewRounds: reviewRounds(db, execution, str(row['pr_author'])),
      factoryMs:
        startToHandoffMs === null ? null : Math.max(0, startToHandoffMs - waitingBeforeHandoff),
      factoryVersion: str(row['factory_version']),
      followUpCommits:
        handoff === null
          ? 0
          : Number(
              db
                .prepare(
                  'SELECT count(*) AS n FROM pull_request_commits WHERE execution_id = ? AND committed_at > ?',
                )
                .get(execution, handoff)?.['n'] ?? 0,
            ),
      handedOffAt,
      handoffToMergeMs: ms(handedOffAt, mergedAt),
      interventions: {
        limitPauses: count(
          "SELECT count(*) AS n FROM attention_requests WHERE execution_id = ? AND kind = 'policy_limit'",
        ),
        manualCompletes:
          outcome === 'unknown'
            ? count(
                "SELECT count(*) AS n FROM events WHERE execution_id = ? AND kind = 'complete' AND (actor IS NULL OR actor <> 'code-host')",
              )
            : 0,
        manualRetries: count(
          "SELECT count(*) AS n FROM events WHERE execution_id = ? AND kind = 'retry'",
        ),
        questions: count(
          "SELECT count(*) AS n FROM attention_requests WHERE execution_id = ? AND kind = 'agent_question'",
        ),
        replies: count(
          'SELECT count(*) AS n FROM attention_replies AS r JOIN attention_requests AS q ON q.id = r.request_id WHERE q.execution_id = ?',
        ),
        stops: count("SELECT count(*) AS n FROM events WHERE execution_id = ? AND kind = 'stop'"),
      },
      key: keyOfFactoryDir(factoryDir),
      leadMs: ms(startedAt, mergedAt),
      mergedAt,
      outcome,
      overheadMs: stageTotal === 0 ? null : Math.max(0, stageTotal - agentMs),
      stageMs,
      startedAt,
      startToHandoffMs,
      tokens: Number(row['tokens_total'] ?? 0),
      ...tokenCategories(row),
      waitingMs,
    };
  });
}

export function factoryVersionsSeen(facts: Array<TicketFacts>): Array<string> {
  return [
    ...new Set(
      facts.flatMap((item) => (item.factoryVersion === null ? [] : [item.factoryVersion])),
    ),
  ].sort();
}

export function statsIdentity(db: DatabaseSync): { factoryId: string } {
  return { factoryId: factoryIdentity(db).factoryId };
}
