import type { DatabaseSync } from 'node:sqlite';
import type { ExecutionId } from '../domain.ts';
import { flowOrder } from '../stages/flow.ts';
import { stages as definitions } from '../stages/index.ts';

// The all-stage usage table. Stage rows sum per-run deltas; the total comes
// from each session's latest cumulative snapshot, so a resumed session is
// counted once.

export type UsageRow = {
  cacheRead: number | null;
  cacheWrite: number | null;
  // Highest context use of any session in the stage, as a percentage.
  context: number | null;
  costMicros: number | null;
  input: number | null;
  label: string;
  models: Array<string>;
  output: number | null;
  sessions: number;
  total: number | null;
};

// Rows follow the flow, so every stage with sessions gets one.
const stages = flowOrder.map((stage) => ({
  label: definitions[stage].label,
  stage,
}));

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export function usageRows(
  db: DatabaseSync,
  execution: ExecutionId,
  options: { includeWrapup: boolean },
): Array<UsageRow> {
  const included = stages.filter((item) => options.includeWrapup || item.stage !== 'wrapup');
  const placeholders = included.map(() => '?').join(', ');
  const names = included.map((item) => item.stage);
  const byStage = db
    .prepare(
      `SELECT s.stage AS stage,
              count(DISTINCT s.id) AS sessions,
              group_concat(DISTINCT s.model) AS models,
              sum(u.delta_tokens_input) AS input,
              sum(u.delta_tokens_output) AS output,
              sum(u.delta_tokens_cache_read) AS cache_read,
              sum(u.delta_tokens_cache_write) AS cache_write,
              sum(u.delta_tokens_total) AS total,
              sum(u.delta_cost_usd_micros) AS cost
       FROM agent_sessions AS s
       LEFT JOIN usage_snapshots AS u ON u.session_id = s.id
       WHERE s.execution_id = ? AND s.stage IN (${placeholders})
       GROUP BY s.stage`,
    )
    .all(execution, ...names);
  const context = db
    .prepare(
      `SELECT s.stage AS stage,
              max(100.0 * u.context_tokens / u.context_window) AS context
       FROM latest_usage_by_session AS u
       JOIN agent_sessions AS s ON s.id = u.session_id
       WHERE s.execution_id = ? AND u.context_tokens IS NOT NULL AND u.context_window IS NOT NULL
       GROUP BY s.stage`,
    )
    .all(execution);
  const totals = db
    .prepare(
      `SELECT count(DISTINCT s.id) AS sessions,
              sum(u.cumulative_tokens_input) AS input,
              sum(u.cumulative_tokens_output) AS output,
              sum(u.cumulative_tokens_cache_read) AS cache_read,
              sum(u.cumulative_tokens_cache_write) AS cache_write,
              sum(u.cumulative_tokens_total) AS total,
              sum(u.cumulative_cost_usd_micros) AS cost
       FROM agent_sessions AS s
       LEFT JOIN latest_usage_by_session AS u ON u.session_id = s.id
       WHERE s.execution_id = ? AND s.stage IN (${placeholders})`,
    )
    .get(execution, ...names);
  const rows: Array<UsageRow> = [];
  for (const item of included) {
    const found = byStage.find((entry) => entry['stage'] === item.stage);
    if (found === undefined) {
      continue;
    }
    const models = typeof found['models'] === 'string' ? found['models'].split(',') : [];
    rows.push({
      cacheRead: numberOrNull(found['cache_read']),
      cacheWrite: numberOrNull(found['cache_write']),
      context: numberOrNull(context.find((entry) => entry['stage'] === item.stage)?.['context']),
      costMicros: numberOrNull(found['cost']),
      input: numberOrNull(found['input']),
      label: item.label,
      models: [...new Set(models)].sort(),
      output: numberOrNull(found['output']),
      sessions: numberOrNull(found['sessions']) ?? 0,
      total: numberOrNull(found['total']),
    });
  }
  rows.push({
    cacheRead: numberOrNull(totals?.['cache_read']),
    cacheWrite: numberOrNull(totals?.['cache_write']),
    context: null,
    costMicros: numberOrNull(totals?.['cost']),
    input: numberOrNull(totals?.['input']),
    label: 'Total',
    models: [],
    output: numberOrNull(totals?.['output']),
    sessions: numberOrNull(totals?.['sessions']) ?? 0,
    total: numberOrNull(totals?.['total']),
  });
  return rows;
}

function tokens(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-US');
}

// USD from micros, keeping the recorded precision.
export function usd(micros: number | null): string {
  if (micros === null) {
    return '—';
  }
  const fixed = (micros / 1_000_000).toFixed(6).replace(/0+$/, '');
  const [whole = '0', fraction = ''] = fixed.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

// An aligned plain-text table: it has to read well in a terminal card and in
// a prompt, so no Markdown pipes. Models follow on their own line.
export function formatUsageTable(rows: Array<UsageRow>): string {
  const header = [
    'Stage',
    'Sess',
    'Input',
    'Output',
    'Cache rd',
    'Cache wr',
    'Total',
    'Ctx',
    'USD',
  ];
  const body = rows.map((row) => [
    row.label,
    String(row.sessions),
    tokens(row.input),
    tokens(row.output),
    tokens(row.cacheRead),
    tokens(row.cacheWrite),
    tokens(row.total),
    row.context === null ? '—' : `${Math.round(row.context)}%`,
    usd(row.costMicros),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...body.map((cells) => (cells[column] ?? '').length)),
  );
  const line = (cells: Array<string>) =>
    cells
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
      )
      .join('  ')
      .trimEnd();
  const models = rows
    .filter((row) => row.models.length > 0)
    .map((row) => `${row.label.toLowerCase()} ${row.models.join(', ')}`);
  return [
    line(header),
    ...body.map((cells) => line(cells)),
    ...(models.length === 0 ? [] : [`Models: ${models.join(' · ')}`]),
  ].join('\n');
}

export function usageTable(
  db: DatabaseSync,
  execution: ExecutionId,
  options: { includeWrapup: boolean },
): string {
  return formatUsageTable(usageRows(db, execution, options));
}
