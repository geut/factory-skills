import type { Limits } from '../config.ts';
import type { Policy, StageName } from '../domain.ts';
import { childInstructions } from './prompt.ts';

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

export type StageDefinition<Input = unknown, Name extends StageName = StageName> = {
  autoExit: true;
  contract: string;
  corrections: CorrectionPolicy;
  emoji: string;
  // The stage's name in prose, such as "Wrap-up".
  label: string;
  // The policy model this stage's agent runs on.
  model: keyof Policy['models'];
  name: Name;
  // Pure: the run's output read against the stage's contract.
  parse: (output: string, round: number) => ParsedOutput;
  // Whether runs wait for the stage's input preparation (its effects).
  preparesInput: boolean;
  // `task` stages run once per task and need a task id on their session.
  scope: 'ticket' | 'task';
  skill: string;
  spawning: false;
  thinking: string;
  tools: ReadonlyArray<string>;
  // The prompt for one run. Throws for an ask the stage cannot take.
  turn: (ask: Ask<Input>) => string;
};

type StageSpec<Input, Name extends StageName> = Omit<
  StageDefinition<Input, Name>,
  'autoExit' | 'parse' | 'spawning' | 'turn'
> & {
  parse?: (output: string, round: number) => ParsedOutput;
  prompts: {
    correction: (failures: Array<string>) => string;
    initial: (input: Input) => string;
    reply?: (answer: string) => string;
    returned?: (round: number, problems: Array<string>) => string;
  };
};

// A stage from its spec. A reply prompt defaults to passing the answer on, and
// output defaults to unchecked.
export function defineStage<Input, const Name extends StageName>(
  spec: StageSpec<Input, Name>,
): StageDefinition<Input, Name> {
  const { prompts, ...rest } = spec;
  return {
    ...rest,
    autoExit: true,
    parse: spec.parse ?? ((output) => ({ json: JSON.stringify({ output }), kind: 'unchecked' })),
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
