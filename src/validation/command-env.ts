import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BASES_ENV, basesEnv, type ComparisonBases } from './bases.ts';
import { SELECTION_ENV, type SelectedTest, type ValidationSelection } from './selection.ts';

// The environment a validation command runs in: work's commands, QA's own,
// and QA's run of the work commands. Each command gets a fresh object, so
// parallel tickets never see each other's values.

// Where project validators keep their run artifacts, such as logs and the
// pointers to the latest one: `validation-logs/` at the factory root. Tickets
// run in parallel under one root, so wrap-up never compares it.
export const VALIDATION_LOGS = 'validation-logs';
export const VALIDATION_LOGS_ENV = 'FACTORY_VALIDATION_LOGS';

export function validationLogsDir(factoryRoot: string): string {
  return path.join(factoryRoot, VALIDATION_LOGS);
}

// Makes the logs directory, so a validator can write to it at once: private
// to the owner, as logs may hold secrets a test printed. A directory that is
// already there keeps its mode. Only in a factory root that exists; a
// validator that needs it and finds none fails on its own.
export function ensureValidationLogs(factoryRoot: string): void {
  if (!existsSync(factoryRoot)) {
    return;
  }
  try {
    mkdirSync(validationLogsDir(factoryRoot), { mode: 0o700, recursive: true });
  } catch {
    // A root the server cannot write: the validator reports it.
  }
}

// A fresh environment for one command: the server's own, with where to log,
// the ticket's comparison commits, and the worker's selection when there is
// one. The server's own copies of these never leak into a ticket's command.
export function commandEnv(input: {
  bases: ComparisonBases;
  factoryRoot: string;
  tests: Array<SelectedTest> | null;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [SELECTION_ENV, ...BASES_ENV]) {
    delete env[name];
  }
  Object.assign(env, basesEnv(input.bases));
  env[VALIDATION_LOGS_ENV] = validationLogsDir(input.factoryRoot);
  if (input.tests !== null && input.tests.length > 0) {
    env[SELECTION_ENV] = JSON.stringify({
      tests: input.tests,
      version: 1,
    } satisfies ValidationSelection);
  }
  return env;
}
