// Prompt pieces every stage shares.

const handshakeTools = ['caller_ping', 'subagent_done'] as const;

// What work and QA mean by an end-to-end test, the kind QA owns when it runs.
// A project without a UI has one too: its API, jobs, or CLI are its outside.
export const END_TO_END =
  "An end-to-end test proves a criterion from outside the code: through a browser, an HTTP API (one request through the framework's test client), a job run synchronously, or a CLI run.";

export function childToolList(tools: ReadonlyArray<string>): string {
  return [...tools, ...handshakeTools].join(',');
}

// `handoff` replaces the default "return only the template" line, for a stage
// whose result is the files it writes rather than its reply.
export function childInstructions(skill: string, contract: string, handoff?: string): string {
  return [
    `Follow the ${skill} skill.`,
    handoff ?? `Return only the ${contract} template, then call subagent_done once.`,
    'If subagent_done replies that the session is shutting down, stop. Do not call it again, do not call caller_ping, and do not send more text.',
    'Use caller_ping instead when you need a decision you cannot make.',
    'Do not launch another stage or edit factory state.',
  ].join('\n');
}
