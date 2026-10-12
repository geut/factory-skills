import type { RunRecord } from '../domain.ts';

// The agent's raw response for a finished run.
export function runOutput(run: RunRecord): string {
  if (run.resultJson === null) {
    return '';
  }
  try {
    const parsed: unknown = JSON.parse(run.resultJson);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'output' in parsed &&
      typeof parsed.output === 'string'
    ) {
      return parsed.output;
    }
    return run.resultJson;
  } catch {
    return run.resultJson;
  }
}
