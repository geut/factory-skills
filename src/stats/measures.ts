import type { RunFacts, TicketFacts, TokenCategories } from './facts.ts';

// Aggregates over fact rows. See docs/stats-v1.md for each definition.

export function median(values: Array<number>): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function present(values: Array<number | null>): Array<number> {
  return values.filter((value): value is number => value !== null);
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

// Merge rate counts tickets whose outcome is known: merged, abandoned, or
// cancelled. Open and unknown tickets are left out rather than counted as
// failures.
export function mergeRate(facts: Array<TicketFacts>): number | null {
  const merged = facts.filter((item) => item.outcome === 'merged').length;
  const known = facts.filter(
    (item) =>
      item.outcome === 'merged' || item.outcome === 'abandoned' || item.outcome === 'cancelled',
  ).length;
  return ratio(merged, known);
}

function interventionTotal(item: TicketFacts): number {
  return Object.values(item.interventions).reduce((sum, value) => sum + value, 0);
}

export function summarize(facts: Array<TicketFacts>) {
  const outcomes = { abandoned: 0, cancelled: 0, merged: 0, open: 0, unknown: 0 };
  for (const item of facts) {
    outcomes[item.outcome] += 1;
  }
  const withPullRequest = facts.filter(
    (item) => item.outcome === 'merged' || item.outcome === 'abandoned',
  );
  const distribution: Record<string, number> = {};
  for (const item of withPullRequest) {
    const key = String(item.externalReviewRounds.total);
    distribution[key] = (distribution[key] ?? 0) + 1;
  }
  const interventions = {
    limitPauses: 0,
    manualCompletes: 0,
    manualRetries: 0,
    questions: 0,
    replies: 0,
    stops: 0,
  };
  for (const item of facts) {
    for (const key of Object.keys(interventions) as Array<keyof typeof interventions>) {
      interventions[key] += item.interventions[key];
    }
  }
  return {
    costUsd: facts.reduce((sum, item) => sum + item.costUsd, 0),
    externalReviewRounds: {
      bot: withPullRequest.reduce((sum, item) => sum + item.externalReviewRounds.bot, 0),
      changesRequested: withPullRequest.reduce(
        (sum, item) => sum + item.externalReviewRounds.changesRequested,
        0,
      ),
      commented: withPullRequest.reduce(
        (sum, item) => sum + item.externalReviewRounds.commented,
        0,
      ),
      distribution,
      human: withPullRequest.reduce((sum, item) => sum + item.externalReviewRounds.human, 0),
      median: median(withPullRequest.map((item) => item.externalReviewRounds.total)),
    },
    followUpCommits: facts.reduce((sum, item) => sum + item.followUpCommits, 0),
    handedOff: facts.filter((item) => item.handedOffAt !== null).length,
    interventions,
    medianMs: {
      factory: median(present(facts.map((item) => item.factoryMs))),
      handoffToMerge: median(present(facts.map((item) => item.handoffToMergeMs))),
      lead: median(present(facts.map((item) => item.leadMs))),
      waiting: median(facts.map((item) => item.waitingMs)),
    },
    mergeRate: mergeRate(facts),
    neededAPerson: facts.filter((item) => interventionTotal(item) > 0).length,
    outcomes,
    started: facts.length,
    tokens: facts.reduce((sum, item) => sum + item.tokens, 0),
  };
}

export function stageMeasures(runs: Array<RunFacts>) {
  const groups = new Map<string, Array<RunFacts>>();
  for (const run of runs) {
    const key = `${run.stage}\u0000${run.setup}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()]
    .map((group) => {
      const first = group[0];
      const initial = group.filter((run) => run.purpose === 'initial' && run.passed !== null);
      const accepted = group.filter((run) => run.passed === true).length;
      const corrections = group.filter((run) => run.purpose === 'validation_correction').length;
      const tokens = group.reduce((sum, run) => sum + run.tokens, 0);
      // A category totals the runs whose usage is known; null when none is.
      const category = (key: keyof TokenCategories) => {
        const known = group.flatMap((run) => (run[key] === null ? [] : [run[key]]));
        return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
      };
      const cost = group.reduce((sum, run) => sum + run.costUsd, 0);
      const returns: Record<string, number> = {};
      for (const run of group) {
        if (run.returnedFrom !== null) {
          returns[run.returnedFrom] = (returns[run.returnedFrom] ?? 0) + 1;
        }
      }
      const roundsByTask = new Map<string, number>();
      for (const run of group) {
        if (run.task !== null) {
          roundsByTask.set(
            `${run.execution}/${run.task}`,
            Math.max(roundsByTask.get(`${run.execution}/${run.task}`) ?? 0, run.round),
          );
        }
      }
      const rounds = [...roundsByTask.values()];
      return {
        acceptedOutputs: accepted,
        agentMs: group.reduce((sum, run) => sum + (run.agentMs ?? 0), 0),
        correctionsPerAcceptedOutput: ratio(corrections, accepted),
        costUsdPerAcceptedOutput: ratio(cost, accepted),
        firstPassAcceptance: ratio(
          initial.filter((run) => run.passed === true).length,
          initial.length,
        ),
        infrastructureLost: group.filter((run) => run.infrastructureLost).length,
        model: first?.model ?? '',
        returnsToWork: returns,
        reviewRoundsPerTask:
          rounds.length === 0
            ? null
            : rounds.reduce((sum, value) => sum + value, 0) / rounds.length,
        runs: group.length,
        setup: first?.setup ?? '',
        stage: first?.stage ?? '',
        thinking: first?.thinking ?? '',
        tokens,
        tokensCacheRead: category('tokensCacheRead'),
        tokensCacheWrite: category('tokensCacheWrite'),
        tokensInput: category('tokensInput'),
        tokensOutput: category('tokensOutput'),
        tokensPerAcceptedOutput: ratio(tokens, accepted),
      };
    })
    .sort(
      (left, right) =>
        left.stage.localeCompare(right.stage) || left.setup.localeCompare(right.setup),
    );
}

export function configurationMeasures(facts: Array<TicketFacts>) {
  const groups = new Map<string, Array<TicketFacts>>();
  for (const item of facts) {
    groups.set(item.configuration, [...(groups.get(item.configuration) ?? []), item]);
  }
  return [...groups.entries()]
    .map(([configuration, group]) => {
      const withPullRequest = group.filter(
        (item) => item.outcome === 'merged' || item.outcome === 'abandoned',
      );
      return {
        configuration,
        interventions: group.reduce((sum, item) => sum + interventionTotal(item), 0),
        medianCostUsd: median(group.map((item) => item.costUsd)),
        medianExternalReviewRounds: median(
          withPullRequest.map((item) => item.externalReviewRounds.total),
        ),
        medianFactoryMs: median(present(group.map((item) => item.factoryMs))),
        merged: group.filter((item) => item.outcome === 'merged').length,
        mergeRate: mergeRate(group),
        tickets: group.length,
      };
    })
    .sort((left, right) => left.configuration.localeCompare(right.configuration));
}
