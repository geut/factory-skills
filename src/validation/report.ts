import type { ControllerEvent, FactorySnapshot, RunRecord, SessionRecord } from '../domain.ts';
import type { PullRequestLookup } from './wrapup.ts';

// What a validator concludes about one run. `failed` asks the agent for a
// correction; `error` is infrastructure trouble and retries the validation.
// `detail` carries what the controller needs from a stage beyond pass/fail.

export type ValidationCheck = {
  command?: string | null;
  details: string;
  durationMs?: number | null;
  exitCode?: number | null;
  kind: 'artifact' | 'schema' | 'policy' | 'command' | 'diff';
  name: string;
  outputExcerpt?: string | null;
  status: 'passed' | 'failed' | 'error';
};

export type ValidationReport<Passed = null, Failed = null> =
  | {
      checks: Array<ValidationCheck>;
      detail: Passed;
      status: 'passed';
      summary: null;
      version: string;
    }
  | {
      checks: Array<ValidationCheck>;
      detail: Failed;
      failures: Array<string>;
      status: 'failed';
      summary: string;
      version: string;
    }
  | { checks: Array<ValidationCheck>; status: 'error'; summary: string; version: string };

export function passedReport<Passed>(
  version: string,
  checks: Array<ValidationCheck>,
  detail: Passed,
): ValidationReport<Passed, never> {
  return { checks, detail, status: 'passed', summary: null, version };
}

export function failedReport<Failed>(
  version: string,
  checks: Array<ValidationCheck>,
  failures: Array<string>,
  detail: Failed,
): ValidationReport<never, Failed> {
  return { checks, detail, failures, status: 'failed', summary: failures.join('\n'), version };
}

export function errorReport(version: string, message: string): ValidationReport<never, never> {
  return { checks: [], status: 'error', summary: message, version };
}

export function failuresOf(checks: Array<ValidationCheck>): Array<string> {
  return checks
    .filter((check) => check.status === 'failed')
    .map((check) => `${check.name}: ${check.details}`);
}

// What a validator is given: the persisted state, the finished run, and the
// effects it may call. It inspects the worktree and factory files itself and
// never writes controller state.
export type ValidationContext = {
  deps: {
    findPullRequest: PullRequestLookup;
    // The all-stage usage table, including finished wrap-up runs.
    usage: () => string;
  };
  run: RunRecord;
  session: SessionRecord;
  snapshot: FactorySnapshot;
};

type ValidationFinished = Extract<ControllerEvent, { kind: 'validation_finished' }>;

export type ValidatedStage = ValidationFinished['stage'];

export type StageValidationReport<S extends ValidatedStage> = Extract<
  ValidationFinished,
  { stage: S }
>['report'];

// A stage's validator. One that declares `leaseMs` is long-running: it runs
// outside the dispatch loop and holds its action for that long.
export type Validator<S extends ValidatedStage> = {
  leaseMs?: (snapshot: FactorySnapshot) => number;
  validate: (context: ValidationContext) => Promise<StageValidationReport<S>>;
  version: string;
};
