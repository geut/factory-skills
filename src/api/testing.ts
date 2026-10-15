import type { FactoryCommands } from '../controller/service.ts';

// For tests whose routes run no commands.
const unused = (): never => {
  throw new Error('this test runs no commands');
};

export const unusedCommands: FactoryCommands = {
  complete: unused,
  reply: unused,
  retry: unused,
  start: unused,
};
