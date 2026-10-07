export const stageLaunchPolicy = {
  plan: {
    autoExit: true,
    contract: 'factory.plan.v3',
    skill: 'factory-plan',
    spawning: false,
    thinking: 'medium',
    tools: ['read', 'bash', 'grep', 'find', 'ls'],
  },
  review: {
    autoExit: true,
    contract: 'factory.review.v4',
    skill: 'factory-review',
    spawning: false,
    thinking: 'high',
    tools: ['read', 'grep', 'find', 'ls'],
  },
  work: {
    autoExit: true,
    contract: 'factory.work.v3',
    skill: 'factory-work',
    spawning: false,
    thinking: 'medium',
    tools: ['read', 'bash', 'grep', 'find', 'ls', 'edit', 'write'],
  },
  wrapup: {
    autoExit: true,
    contract: 'factory.wrapup.v1',
    skill: 'factory-wrapup',
    spawning: false,
    thinking: 'medium',
    tools: ['read', 'bash', 'grep', 'find', 'ls'],
  },
} as const;

const stageEmoji = {
  plan: '🔎',
  review: '👀',
  work: '🛠',
  wrapup: '📦',
} as const;

const handshakeTools = ['caller_ping', 'subagent_done'] as const;

export function paneLabel(
  stage: keyof typeof stageEmoji,
  displayRef: string,
  taskId: string | null,
): string {
  const emoji = stageEmoji[stage];
  if (stage === 'work' && taskId !== null) {
    return `${emoji} ${displayRef} ${taskId}`;
  }
  return `${emoji} ${displayRef}`;
}

export function childToolList(stage: keyof typeof stageLaunchPolicy): string {
  return [...stageLaunchPolicy[stage].tools, ...handshakeTools].join(',');
}

export function childDescription(title: string): string {
  const stripped = title
    .replaceAll(/\([^)]*\)/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  const words = stripped
    .split(' ')
    .filter((word) => word.length > 0)
    .slice(0, 8);
  if (words.length === 0) {
    return 'Untitled factory task';
  }
  const phrase = words.join(' ');
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

export function childInstructions(skill: string, contract: string): string {
  return [
    `Follow the ${skill} skill.`,
    `Return only the ${contract} template, then call subagent_done.`,
    'Use caller_ping instead when you need a decision.',
    'Do not launch another stage or edit factory state.',
  ].join('\n');
}

export function planPrompt(input: {
  body: string;
  displayRef: string;
  factoryDir: string;
  title: string;
}): string {
  const policy = stageLaunchPolicy.plan;
  return [
    childInstructions(policy.skill, policy.contract),
    '',
    `Ticket: ${input.displayRef}`,
    `Title: ${input.title}`,
    `Write plan.md and numbered task files in ${input.factoryDir}.`,
    '',
    input.body,
  ].join('\n');
}

export function correctionPrompt(failures: Array<string>): string {
  const policy = stageLaunchPolicy.plan;
  return [
    childInstructions(policy.skill, policy.contract),
    '',
    'Plan validation failed. plan.md must exist and at least one task file must be defined. Fix these exact problems, then return the factory.plan.v3 template again:',
    ...failures.map((failure) => `- ${failure}`),
  ].join('\n');
}

export function replyPrompt(answer: string): string {
  const policy = stageLaunchPolicy.plan;
  return [childInstructions(policy.skill, policy.contract), '', 'The user answered:', answer].join(
    '\n',
  );
}

export function workPrompt(input: {
  displayRef: string;
  planPath: string;
  taskFile: string;
  title: string;
  worktree: string;
}): string {
  const policy = stageLaunchPolicy.work;
  return [
    childInstructions(policy.skill, policy.contract),
    '',
    `Ticket: ${input.displayRef}`,
    `Task: ${input.title}`,
    `Task file: ${input.taskFile}`,
    `Plan: ${input.planPath}`,
    `Work only in ${input.worktree}.`,
  ].join('\n');
}
