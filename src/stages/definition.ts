import type { Policy, StageName } from '../domain.ts';
import { childInstructions } from './prompt.ts';

// Why a run of a stage exists, and what its prompt must carry.
export type Ask<Input> =
  | { input: Input; kind: 'initial' }
  | { failures: Array<string>; kind: 'correction' }
  | { answer: string; kind: 'reply' }
  // A later stage sent the task back with problems to fix.
  | { kind: 'return'; problems: Array<string>; round: number };

export type StageDefinition<Input = unknown, Name extends StageName = StageName> = {
  autoExit: true;
  contract: string;
  emoji: string;
  // The policy model this stage's agent runs on.
  model: keyof Policy['models'];
  name: Name;
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
  'autoExit' | 'spawning' | 'turn'
> & {
  prompts: {
    correction: (failures: Array<string>) => string;
    initial: (input: Input) => string;
    reply?: (answer: string) => string;
    returned?: (round: number, problems: Array<string>) => string;
  };
};

// A stage from its spec. A reply prompt defaults to passing the answer on.
export function defineStage<Input, const Name extends StageName>(
  spec: StageSpec<Input, Name>,
): StageDefinition<Input, Name> {
  const { prompts, ...rest } = spec;
  return {
    ...rest,
    autoExit: true,
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
