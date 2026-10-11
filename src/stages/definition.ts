import type { Limits } from '../config.ts';
import type {
  FactorySnapshot,
  PlannedTask,
  Policy,
  RunRecord,
  StageName,
  TaskRecord,
  TaskSummary,
} from '../domain.ts';
import type { StageValidationReport, ValidationCheck } from '../validation/report.ts';
import { childInstructions } from './prompt.ts';

// What the driver shows a stage about the execution it runs in. Stages read
// it and never change it.
export type StageView = {
  snapshot: FactorySnapshot;
  // The task a per-task stage runs for.
  task: TaskRecord | null;
};

// What a per-task stage passes to the next one when it accepts: the diff it
// leaves in the worktree, the checks it passed, and its agent's response.
export type Handoff = { checks: Array<ValidationCheck>; diff: string; output: string };

// What a stage concludes from its validator's report on a finished run. The
// driver carries it out: budgets, sessions, runs, and the order of stages
// stay with the driver.
export type Outcome =
  | {
      // For a per-task stage, what the next per-task stage is given.
      handoff?: Handoff;
      kind: 'accept';
      // For the closing stage: what the person reads at handoff.
      notice?: string;
      // For the stage that plans: the tasks to register, from its plan.
      plan?: { path: string; tasks: Array<PlannedTask> };
      summary?: TaskSummary;
    }
  | { failures: Array<string>; kind: 'correct' }
  // The product does not do what the task asks; work fixes these problems.
  | { kind: 'return_to_work'; problems: Array<string>; summary: TaskSummary }
  // The worktree changed after this stage was given its diff.
  | { kind: 'revalidate_previous' }
  | {
      code: string;
      failures: Array<string>;
      kind: 'pause';
      // The driver's reply to the event, for the log.
      message: string;
      question: string;
      // Whether a reply resumes this stage's agent.
      reply: boolean;
      summary?: TaskSummary;
    };

export type Concluded<Name extends StageName> = Exclude<
  StageValidationReport<Name>,
  { status: 'error' }
>;

// Why a run of a stage exists, and what its prompt must carry.
export type Ask<Input> =
  | { input: Input; kind: 'initial' }
  | { failures: Array<string>; kind: 'correction' }
  | { answer: string; kind: 'reply' }
  // A later stage sent the task back with problems to fix.
  | { kind: 'return'; problems: Array<string>; round: number };

// What a finished run's raw output means, before any validator runs.
// `unchecked` output has no contract of its own and is left to the validator.
export type ParsedOutput =
  | { json: string; kind: 'valid' }
  | { error: string; json: string; kind: 'invalid' }
  | { json: string; kind: 'unchecked' };

// How a stage's agent corrects output its validator failed.
export type CorrectionPolicy = {
  // The limit in the execution policy, or null for corrections without limit.
  limit: keyof Limits | null;
  // The notice's first line when the limit is reached.
  limitNotice: string;
  // `round` budgets corrections per round of the stage, `session` across it.
  per: 'round' | 'session';
};

export type StageDefinition<
  Input = unknown,
  Name extends StageName = StageName,
  Prepared = null,
> = {
  autoExit: true;
  // Pure: what the stage concludes from a report that passed or failed.
  conclude: (view: StageView, run: RunRecord, report: Concluded<Name>) => Outcome;
  contract: string;
  corrections: CorrectionPolicy;
  emoji: string;
  // The input for a stage's first run of a task (or ticket): what its input
  // preparation found, what the previous per-task stage handed on, and the
  // round the run starts. The stage that plans starts from the ticket instead.
  input?: (
    view: StageView,
    from: { handoff: Handoff | null; prepared: Prepared; round: number },
  ) => Input;
  // The stage's name in prose, such as "Wrap-up".
  label: string;
  // The policy model this stage's agent runs on.
  model: keyof Policy['models'];
  name: Name;
  // An optional stage runs only when the project's configuration enables it.
  optional: boolean;
  // Pure: the run's output read against the stage's contract.
  parse: (output: string, round: number) => ParsedOutput;
  // Whether runs wait for the stage's input preparation (its effects).
  preparesInput: boolean;
  // Whether each first run or reentry of a task starts a new numbered round.
  rounds: boolean;
  // The state before the stage's first run, kept on that run for the
  // validator to compare against.
  runBaseline?: (prepared: Prepared) => string | null;
  // `task` stages run once per task and need a task id on their session.
  scope: 'ticket' | 'task';
  skill: string;
  spawning: false;
  thinking: string;
  tools: ReadonlyArray<string>;
  // The prompt for one run. Throws for an ask the stage cannot take.
  turn: (ask: Ask<Input>) => string;
};

type StageSpec<Input, Name extends StageName, Prepared> = Omit<
  StageDefinition<Input, Name, Prepared>,
  'autoExit' | 'optional' | 'parse' | 'rounds' | 'spawning' | 'turn'
> & {
  optional?: boolean;
  parse?: (output: string, round: number) => ParsedOutput;
  prompts: {
    correction: (failures: Array<string>) => string;
    initial: (input: Input) => string;
    reply?: (answer: string) => string;
    returned?: (round: number, problems: Array<string>) => string;
  };
  rounds?: boolean;
};

// A stage from its spec. A reply prompt defaults to passing the answer on, and
// output defaults to unchecked.
export function defineStage<Input, const Name extends StageName, Prepared = null>(
  spec: StageSpec<Input, Name, Prepared>,
): StageDefinition<Input, Name, Prepared> {
  const { prompts, ...rest } = spec;
  return {
    ...rest,
    autoExit: true,
    optional: spec.optional ?? false,
    parse: spec.parse ?? ((output) => ({ json: JSON.stringify({ output }), kind: 'unchecked' })),
    rounds: spec.rounds ?? false,
    spawning: false,
    turn: (ask) => {
      switch (ask.kind) {
        case 'initial':
          return prompts.initial(ask.input);
        case 'correction':
          return prompts.correction(ask.failures);
        case 'reply':
          return (prompts.reply ?? defaultReply(spec))(ask.answer);
        case 'return':
          if (prompts.returned === undefined) {
            throw new Error(`The ${spec.name} stage cannot take a return to work.`);
          }
          return prompts.returned(ask.round, ask.problems);
        default: {
          const _exhaustive: never = ask;
          return _exhaustive;
        }
      }
    },
  };
}

function defaultReply(spec: { contract: string; skill: string }) {
  return (answer: string) =>
    [childInstructions(spec.skill, spec.contract), '', 'The user answered:', answer].join('\n');
}
