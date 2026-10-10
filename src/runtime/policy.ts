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

export const stageEmoji = {
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

const runStatusLabels = {
  human_reply: 'reply',
  infrastructure_retry: 'retry',
  initial: 'initial',
  manual_continue: 'continue',
  review_changes: 'review',
  validation_correction: 'correction',
} as const;

const taskTitleLimit = 40;
const herdrTokenLimit = 80;

export function runStatusLabel(purpose: keyof typeof runStatusLabels): string {
  return runStatusLabels[purpose];
}

export function clipTaskTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= taskTitleLimit) {
    return trimmed;
  }
  return `${trimmed.slice(0, taskTitleLimit - 1)}…`;
}

export function taskProgressText(title: string, tasksLeft: number): string {
  const suffix = ` · ${tasksLeft} left`;
  const clipped = clipTaskTitle(title);
  const room = herdrTokenLimit - suffix.length;
  const visible = clipped.length <= room ? clipped : `${clipped.slice(0, Math.max(0, room - 1))}…`;
  return `${visible}${suffix}`;
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
    `Return only the ${contract} template, then call subagent_done once.`,
    'If subagent_done replies that the session is shutting down, stop. Do not call it again, do not call caller_ping, and do not send more text.',
    'Use caller_ping instead when you need a decision you cannot make.',
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

export function replyPrompt(stage: keyof typeof stageLaunchPolicy, answer: string): string {
  const policy = stageLaunchPolicy[stage];
  return [childInstructions(policy.skill, policy.contract), '', 'The user answered:', answer].join(
    '\n',
  );
}

export function workPrompt(input: {
  adrPath: string | null;
  commands: Array<{ argv: Array<string>; name: string }>;
  contextPath: string | null;
  dependencies: Array<{ status: string; taskId: string }>;
  displayRef: string;
  planPath: string;
  taskFile: string;
  taskId: string;
  taskType: string | null;
  title: string;
  worktree: string;
  worktreeBranch: string;
}): string {
  const policy = stageLaunchPolicy.work;
  const commands =
    input.commands.length === 0
      ? 'none'
      : input.commands.map((command) => `${command.name}: ${command.argv.join(' ')}`).join('\n');
  const dependencies =
    input.dependencies.length === 0
      ? 'none'
      : input.dependencies.map((dep) => `${dep.taskId} (${dep.status})`).join(', ');
  return [
    childInstructions(policy.skill, policy.contract),
    '',
    `Ticket: ${input.displayRef}`,
    `Task: ${input.taskId} ${input.title}`,
    `Type: ${input.taskType ?? 'unspecified'}`,
    `Task file: ${input.taskFile}`,
    `Plan: ${input.planPath}`,
    `ADR: ${input.adrPath ?? 'none'}`,
    `Context: ${input.contextPath ?? 'none'}`,
    `Dependencies: ${dependencies}`,
    `Branch: ${input.worktreeBranch}`,
    `Tools: ${childToolList('work')}`,
    `Work only in ${input.worktree}.`,
    'Leave the work uncommitted.',
    'Configured checks:',
    commands,
  ].join('\n');
}

export function workCorrectionPrompt(failures: Array<string>): string {
  const policy = stageLaunchPolicy.work;
  return [
    childInstructions(policy.skill, policy.contract),
    '',
    'Work validation failed. Fix these exact problems:',
    ...failures.map((failure) => `- ${failure}`),
  ].join('\n');
}

export function reviewPrompt(input: {
  diff: string;
  displayRef: string;
  planPath: string;
  rawOutput: string;
  round: number;
  taskFile: string;
  taskTitle: string;
  validationSummary: string;
}): string {
  const policy = stageLaunchPolicy.review;
  return [
    childInstructions(policy.skill, policy.contract),
    '',
    `Ticket: ${input.displayRef}`,
    `Task: ${input.taskTitle}`,
    `Task file: ${input.taskFile}`,
    `Plan: ${input.planPath}`,
    `Review round: ${input.round}`,
    input.round > 1
      ? 'The worker addressed your earlier blocking findings. Verify those fixes first and keep the same finding numbers for problems that remain.'
      : 'This is the first review of this task.',
    'Read only. Do not edit files.',
    '',
    'Validation:',
    input.validationSummary,
    '',
    'Worker summary:',
    input.rawOutput.length > 0 ? input.rawOutput : 'none',
    '',
    'Diff:',
    input.diff.length > 0 ? input.diff : 'none',
  ].join('\n');
}

export function reviewCorrectionPrompt(failures: Array<string>): string {
  const policy = stageLaunchPolicy.review;
  return [
    childInstructions(policy.skill, policy.contract),
    '',
    `The controller could not read your verdict. Fix these exact problems and return the complete ${policy.contract} template again:`,
    ...failures.map((failure) => `- ${failure}`),
  ].join('\n');
}

export function reviewChangesPrompt(round: number, findings: Array<string>): string {
  const policy = stageLaunchPolicy.work;
  return [
    childInstructions(policy.skill, policy.contract),
    '',
    `Review round ${round} requested changes. Resolve these blocking findings in the same worktree:`,
    ...findings.map((finding) => `- ${finding}`),
    '',
    'Change only what these findings require. Leave the work uncommitted.',
  ].join('\n');
}

export function wrapupPrompt(input: {
  adrPath: string | null;
  baseBranch: string | null;
  codeRoot: string;
  contextPath: string | null;
  displayRef: string;
  factoryRoot: string;
  minorFindings: Array<string>;
  model: string;
  planPath: string;
  pullRequests: boolean;
  tasks: Array<{
    status: string;
    taskFile: string;
    taskId: string;
    title: string;
    verdict: string;
  }>;
  usage: string;
  verification: Array<string>;
  worktree: string;
  worktreeBranch: string;
}): string {
  const policy = stageLaunchPolicy.wrapup;
  return [
    childInstructions(policy.skill, policy.contract),
    '',
    `Ticket: ${input.displayRef}`,
    `Plan: ${input.planPath}`,
    `ADR: ${input.adrPath ?? 'none'}`,
    `Factory root: ${input.factoryRoot}`,
    `Factory context: ${input.contextPath ?? 'none'}`,
    `Code root: ${input.codeRoot}`,
    `Worktree: ${input.worktree}`,
    `Branch: ${input.worktreeBranch}`,
    `Base branch: ${input.baseBranch ?? 'unknown'}`,
    `Model: ${input.model}. Tools: ${childToolList('wrapup')}.`,
    `github.pullRequests: ${input.pullRequests ? 'true' : 'false'}`,
    '',
    'Tasks:',
    ...input.tasks.map(
      (task) =>
        `- ${task.taskId} ${task.title}: ${task.status}, review ${task.verdict} (${task.taskFile})`,
    ),
    '',
    'Final work validation:',
    ...(input.verification.length === 0
      ? ['- none recorded']
      : input.verification.map((line) => `- ${line}`)),
    '',
    'Non-blocking review findings:',
    ...(input.minorFindings.length === 0
      ? ['none']
      : input.minorFindings.map((finding) => `- ${finding}`)),
    '',
    'Usage so far (the controller adds wrap-up after you finish; do not estimate it):',
    input.usage,
    '',
    'The controller checks the handoff against the worktree: ## Files must list every changed path and nothing else, ## Tests must name the validation commands above, and you must not change product code, commit, merge, or push unless github.pullRequests allows it.',
  ].join('\n');
}

export function wrapupCorrectionPrompt(failures: Array<string>): string {
  const policy = stageLaunchPolicy.wrapup;
  return [
    childInstructions(policy.skill, policy.contract),
    '',
    `Wrap-up validation failed. Fix these exact problems and return the complete ${policy.contract} template again:`,
    ...failures.map((failure) => `- ${failure}`),
  ].join('\n');
}
