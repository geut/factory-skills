// Which command a long controller step is running (GLOSSARY.md: controller
// step), kept in the server's memory only: it changes too often to be worth a
// database write, and a restarted server retries the step anyway.

export type CommandProgress = {
  // The command's name in FACTORY.json, such as `test`.
  command: string;
  // Its position among the step's commands, from 1.
  index: number;
  startedAt: string;
  total: number;
};

// What a step's code calls as each of its commands starts, and with null once
// none runs.
export type CommandReporter = (
  progress: Pick<CommandProgress, 'command' | 'index' | 'total'> | null,
) => void;

export const ignoreCommands: CommandReporter = () => undefined;

export type CommandBoard = {
  // The command an action is running, if any.
  get: (actionId: string) => CommandProgress | null;
  // The reporter for one action's commands.
  reporter: (actionId: string) => CommandReporter;
};

export function createCommandBoard(now: () => string): CommandBoard {
  const running = new Map<string, CommandProgress>();
  return {
    get: (actionId) => running.get(actionId) ?? null,
    reporter: (actionId) => (progress) => {
      if (progress === null) {
        running.delete(actionId);
      } else {
        running.set(actionId, { ...progress, startedAt: now() });
      }
    },
  };
}
