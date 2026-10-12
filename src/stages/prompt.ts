// Prompt pieces every stage shares.

const handshakeTools = ['caller_ping', 'subagent_done'] as const;

export function childToolList(tools: ReadonlyArray<string>): string {
  return [...tools, ...handshakeTools].join(',');
}

export function childInstructions(skill: string, contract: string): string {
  return [
    `Follow the ${skill} skill.`,
    `Return only the ${contract} template, then call subagent_done once.`,
    'If subagent_done replies that the session is shutting down, stop. Do not call it again, do not call caller_ping, and do not send more text.',
    'Use caller_ping instead when you need a decision you cannot make.',
    'Do not launch another stage or edit factory state.',
  ].join('\n');
}
