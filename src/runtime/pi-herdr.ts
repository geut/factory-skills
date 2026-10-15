import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  zeroUsage,
  type ReconcileObservation,
  type RunId,
  type TerminalOutcome,
  type UsageTotals,
} from '../domain.ts';
import { connectHerdrEvents, type PaneExitSource } from './herdr-events.ts';
import { runStatusLabel } from './policy.ts';
import type {
  FactorySubagentRuntime,
  LaunchSpec,
  PaneSpec,
  RunStarted,
  TicketTab,
} from './runtime.ts';
import { lastAssistantText } from './session-activity.ts';

export type ClassifiedChild =
  | { kind: 'pending' }
  | { kind: 'caller_ping'; question: string }
  | { kind: 'subagent_done' }
  | { kind: 'completed_user_exit' }
  | { kind: 'launch_failed'; message: string }
  | { kind: 'crashed'; message: string }
  | { kind: 'pane_killed' }
  | { kind: 'gap_exit' };

export type SidecarInput = {
  exitCodeText: string | null;
  exitJson: string | null;
  runId: string;
  sessionEntryCount: number;
  sessionText?: string;
  trigger: 'event' | 'sidecar' | 'gone';
  withinStartupWindow: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function terminalCallAfterMarker(
  sessionText: string,
  runId: string,
): { kind: 'caller_ping'; question: string } | { kind: 'subagent_done' } | null {
  const at = sessionText.indexOf(promptMarker(runId));
  if (at < 0) {
    return null;
  }
  let found: { kind: 'caller_ping'; question: string } | { kind: 'subagent_done' } | null = null;
  for (const line of sessionText.slice(at).split('\n')) {
    const call = terminalToolCall(line);
    if (call?.name === 'caller_ping') {
      found = { kind: 'caller_ping', question: call.question };
    } else if (call?.name === 'subagent_done') {
      found = { kind: 'subagent_done' };
    }
  }
  return found;
}

function terminalToolCall(
  line: string,
): { name: 'caller_ping' | 'subagent_done'; question: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const message = isRecord(parsed) && isRecord(parsed['message']) ? parsed['message'] : null;
  const content = message === null ? null : message['content'];
  if (!Array.isArray(content)) {
    return null;
  }
  let found: { name: 'caller_ping' | 'subagent_done'; question: string } | null = null;
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'toolCall') {
      continue;
    }
    if (block['name'] !== 'subagent_done' && block['name'] !== 'caller_ping') {
      continue;
    }
    const args = isRecord(block['arguments']) ? block['arguments'] : {};
    found = {
      name: block['name'],
      question: typeof args['message'] === 'string' ? args['message'] : '',
    };
  }
  return found;
}

export function promptMarker(runId: string): string {
  return `Factory run ${runId}`;
}

export function markedPrompt(runId: string, prompt: string): string {
  const marker = promptMarker(runId);
  if (prompt === marker || prompt.endsWith(`\n${marker}`)) {
    return prompt;
  }
  return `${prompt}\n${marker}`;
}

export function gateExitSidecar(input: {
  exitJson: string | null;
  runId: string;
  sessionText: string;
}): { discard: boolean; exitJson: string | null } {
  if (input.exitJson !== null && !input.sessionText.includes(promptMarker(input.runId))) {
    return { discard: true, exitJson: null };
  }
  return { discard: false, exitJson: input.exitJson };
}

export function classifySidecar(input: SidecarInput): ClassifiedChild {
  const exitJson =
    input.sessionText !== undefined && !input.sessionText.includes(promptMarker(input.runId))
      ? null
      : input.exitJson;
  if (exitJson !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(exitJson);
    } catch {
      parsed = null;
    }
    if (isRecord(parsed) && parsed['type'] === 'ping') {
      return {
        kind: 'caller_ping',
        question: typeof parsed['message'] === 'string' ? parsed['message'] : '',
      };
    }
    if (isRecord(parsed) && parsed['type'] === 'done') {
      return { kind: 'subagent_done' };
    }
  }
  if (input.exitCodeText !== null) {
    const [codeText, stamped] = input.exitCodeText.trim().split(/\s+/, 2);
    const code = Number(codeText);
    const stampMatches = stamped === undefined || stamped === input.runId;
    const sessionText = input.sessionText ?? '';
    const resumedScript =
      !stampMatches &&
      input.sessionText !== undefined &&
      sessionText.includes(promptMarker(input.runId));
    if (!stampMatches && !resumedScript) {
      return { kind: 'pending' };
    }
    if (!Number.isInteger(code)) {
      return { kind: 'pending' };
    }
    if (resumedScript) {
      if (code !== 0) {
        return { kind: 'crashed', message: `child crashed with exit code ${code}` };
      }
      const call = terminalCallAfterMarker(sessionText, input.runId);
      if (call?.kind === 'caller_ping') {
        return call;
      }
      return { kind: 'subagent_done' };
    }
    if (code === 0) {
      return { kind: 'completed_user_exit' };
    }
    if (input.withinStartupWindow && input.sessionEntryCount === 0) {
      return { kind: 'launch_failed', message: `launch failed with exit code ${code}` };
    }
    return { kind: 'crashed', message: `child crashed with exit code ${code}` };
  }
  if (input.trigger === 'event') {
    return { kind: 'pane_killed' };
  }
  if (input.trigger === 'gone') {
    return { kind: 'gap_exit' };
  }
  return { kind: 'pending' };
}

export function herdrPaneArgs(input: {
  cwd: string;
  launchScript: string;
  targetPaneId: string;
}): Array<string> {
  return [
    'plugin',
    'pane',
    'open',
    '--plugin',
    'pi-herdr-subagents',
    '--entrypoint',
    'argv',
    '--placement',
    'split',
    '--target-pane',
    input.targetPaneId,
    '--direction',
    'right',
    '--cwd',
    input.cwd,
    '--env',
    `PI_HERDR_LAUNCH_SCRIPT=${input.launchScript}`,
    '--no-focus',
  ];
}

export function handshakeExtensionPath(): string {
  return fileURLToPath(new URL('./child-handshake.ts', import.meta.url));
}

export function renderLaunchScript(input: {
  handshakePath: string;
  model: string;
  piBin: string;
  promptFile: string;
  runId: string;
  sessionFile: string;
  thinking: string;
  tools: string;
}): string {
  const session = shellQuote(input.sessionFile);
  const runId = shellQuote(input.runId);
  return `#!/usr/bin/env bash
trap '' TSTP
export PI_SUBAGENT_SESSION=${session}
export PI_SUBAGENT_AUTO_EXIT=1
export FACTORY_CHILD=1
${shellQuote(input.piBin)} --session ${session} -e ${shellQuote(input.handshakePath)} --model ${shellQuote(input.model)} --thinking ${shellQuote(input.thinking)} --tools ${shellQuote(input.tools)} ${shellQuote(`@${input.promptFile}`)}
code=$?
printf "%s %s\\n" "$code" ${runId} > ${session}.exitcode
exit "$code"
`;
}

// The script behind a handoff pane. It execs the TUI so the pane closes with
// it, and FACTORY_CHILD keeps the factory extension out of the reopened Pi.
export function renderPaneScript(input: {
  cwd: string;
  freshBin: string;
  piBin: string;
  target: PaneSpec['target'];
}): string {
  const command =
    input.target.kind === 'session'
      ? `${shellQuote(input.piBin)} --session ${shellQuote(input.target.sessionFile)}`
      : `${shellQuote(input.freshBin)} --no-restore ${shellQuote(input.target.file)}`;
  return `#!/usr/bin/env bash
trap '' TSTP
export FACTORY_CHILD=1
cd ${shellQuote(input.cwd)} || exit 1
exec ${command}
`;
}

export function herdrRenameArgs(paneId: string, label: string): Array<string> {
  return ['pane', 'rename', paneId, label];
}

export function herdrProcessInfoArgs(paneId: string): Array<string> {
  return ['pane', 'process-info', '--pane', paneId];
}

export function herdrAgentPromptArgs(paneId: string, prompt: string): Array<string> {
  return ['agent', 'prompt', paneId, prompt];
}

export function herdrMetadataArgs(input: {
  paneId: string;
  purpose: LaunchSpec['purpose'];
  seq: number;
  taskLabel: string | null;
}): Array<string> {
  const args = [
    'pane',
    'report-metadata',
    input.paneId,
    '--source',
    'factory',
    '--seq',
    String(input.seq),
    '--token',
    `status=${runStatusLabel(input.purpose)}`,
  ];
  if (input.taskLabel !== null && input.taskLabel.length > 0) {
    args.push('--token', `task=${input.taskLabel}`);
  }
  return args;
}

export function paneProcessIsLive(code: number, stdout: string): boolean {
  if (code !== 0) {
    return false;
  }
  const parsed = jsonRecord(stdout);
  if (parsed === null) {
    return false;
  }
  const result = isRecord(parsed['result']) ? parsed['result'] : parsed;
  const info = isRecord(result['process_info']) ? result['process_info'] : null;
  if (info === null) {
    return false;
  }
  const foreground = info['foreground_processes'];
  if (Array.isArray(foreground) && foreground.length > 0) {
    return true;
  }
  const shellPid = info['shell_pid'];
  return typeof shellPid === 'number' && Number.isInteger(shellPid) && shellPid > 0;
}

function jsonRecord(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function usageFromSession(jsonl: string): UsageTotals {
  const usage = zeroUsage();
  for (const line of jsonl.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed['message'])) {
      continue;
    }
    const message = parsed['message'];
    if (!isRecord(message['usage'])) {
      continue;
    }
    // Pi records each request's usage on its message, so the session's
    // totals are the sum over every message.
    const raw = message['usage'];
    usage.inputTokens += numberField(raw, 'input');
    usage.outputTokens += numberField(raw, 'output');
    usage.cacheReadTokens += numberField(raw, 'cacheRead');
    usage.cacheWriteTokens += numberField(raw, 'cacheWrite');
    usage.totalTokens += numberField(raw, 'totalTokens');
    const cost = raw['cost'];
    if (isRecord(cost) && typeof cost['total'] === 'number') {
      usage.costUsdMicros += Math.round(cost['total'] * 1_000_000);
    }
  }
  return usage;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function paneIdFrom(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value['pane_id'] === 'string') {
    return value['pane_id'];
  }
  if (typeof value['paneId'] === 'string') {
    return value['paneId'];
  }
  return (
    paneIdFrom(value['pane']) ?? paneIdFrom(value['plugin_pane']) ?? paneIdFrom(value['result'])
  );
}

export function parsePaneId(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const direct = paneIdFromJson(trimmed);
  if (direct !== null) {
    return direct;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const embedded = paneIdFromJson(trimmed.slice(start, end + 1));
    if (embedded !== null) {
      return embedded;
    }
  }
  if (trimmed.includes('{')) {
    return null;
  }
  const line = trimmed.split('\n').find((item) => item.trim().length > 0);
  return line === undefined ? null : line.trim();
}

function paneIdFromJson(text: string): string | null {
  try {
    return paneIdFrom(JSON.parse(text));
  } catch {
    return null;
  }
}

type CommandResult = { code: number; stderr: string; stdout: string };
type CommandRunner = (args: Array<string>) => Promise<CommandResult>;

function defaultRunner(args: Array<string>): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('herdr', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ code: code ?? 1, stderr, stdout });
    });
  });
}

function readOptional(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function childOutput(classified: ClassifiedChild, jsonl: string): string {
  if (classified.kind === 'subagent_done') {
    return lastAssistantText(jsonl);
  }
  return jsonl;
}

function toTerminal(
  classified: ClassifiedChild,
  output: string,
  usage: UsageTotals,
): TerminalOutcome | null {
  switch (classified.kind) {
    case 'pending':
      return null;
    case 'subagent_done':
      return { kind: 'subagent_done', output, usage };
    case 'caller_ping':
      return { kind: 'caller_ping', question: classified.question, usage };
    case 'completed_user_exit':
      return {
        kind: 'completed_user_exit',
        message: output || 'child exited without subagent_done',
      };
    case 'launch_failed':
      return { kind: 'launch_failed', message: classified.message };
    case 'crashed':
      return { kind: 'crashed', message: classified.message };
    case 'pane_killed':
      return { kind: 'pane_killed', message: 'pane killed' };
    case 'gap_exit':
      return { kind: 'gap_exit', message: 'child ended while the event stream was down' };
    default: {
      const _exhaustive: never = classified;
      return _exhaustive;
    }
  }
}

function writeMarkedPrompt(spec: LaunchSpec): string {
  mkdirSync(path.dirname(spec.sessionFile), { recursive: true });
  const prompt = markedPrompt(spec.runId, spec.prompt);
  writeFileSync(`${spec.sessionFile}.prompt`, prompt);
  return prompt;
}

function clearSidecars(sessionFile: string): void {
  for (const suffix of ['.exit', '.exitcode']) {
    try {
      unlinkSync(`${sessionFile}${suffix}`);
    } catch {
      // The sidecar is already gone.
    }
  }
}

function takeExitJson(sessionFile: string, runId: string, sessionText: string): string | null {
  const exitPath = `${sessionFile}.exit`;
  const gated = gateExitSidecar({
    exitJson: readOptional(exitPath),
    runId,
    sessionText,
  });
  if (gated.discard) {
    try {
      unlinkSync(exitPath);
    } catch {
      // The finishing turn removed it.
    }
  }
  return gated.exitJson;
}

const childPollMs = 5000;

function nested(value: unknown, keys: Array<string>): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function readTabs(file: string | null): Record<string, { rootPaneId: string; tabId: string }> {
  if (file === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, { rootPaneId: string; tabId: string }>)
      : {};
  } catch {
    return {};
  }
}

function noop(): void {
  return undefined;
}

export function createPiHerdrRuntime(options?: {
  events?: PaneExitSource | null;
  freshBin?: string;
  // The child handshake extension Pi loads with -e; the source file by default.
  handshakePath?: string;
  piBin?: string;
  pollMs?: number;
  run?: CommandRunner;
  socketPath?: string;
  // Where each ticket's tab is remembered across restarts.
  tabsFile?: string;
  targetPaneId?: string;
}): FactorySubagentRuntime {
  const run = options?.run ?? defaultRunner;
  const piBin = options?.piBin ?? 'pi';
  const handshakePath = options?.handshakePath ?? handshakeExtensionPath();
  const freshBin = options?.freshBin ?? process.env['FACTORY_FRESH_BIN'] ?? 'fresh';
  const targetPaneId = options?.targetPaneId ?? process.env['HERDR_PANE_ID'] ?? '';
  const tabsFile = options?.tabsFile ?? null;
  const tabs = new Map<string, { rootPaneId: string; tabId: string }>(
    Object.entries(readTabs(tabsFile)),
  );

  function saveTabs(): void {
    if (tabsFile === null) {
      return;
    }
    mkdirSync(path.dirname(tabsFile), { recursive: true });
    writeFileSync(tabsFile, `${JSON.stringify(Object.fromEntries(tabs), null, 2)}\n`);
  }

  // The workspace the host's pane is in, so tickets' tabs open beside it.
  async function hostWorkspace(): Promise<string | null> {
    const got = await run(['pane', 'get', targetPaneId]);
    if (got.code !== 0) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(got.stdout);
      const pane = nested(parsed, ['result', 'pane']) ?? nested(parsed, ['result']);
      const workspace = nested(pane, ['workspace_id']);
      return typeof workspace === 'string' ? workspace : null;
    } catch {
      return null;
    }
  }

  // The pane a ticket's panes split from: its tab's root pane, created the
  // first time. A tab that cannot be made falls back to the host's pane.
  async function splitTarget(tab: TicketTab | null | undefined, cwd: string): Promise<string> {
    if (tab === null || tab === undefined) {
      return targetPaneId;
    }
    const known = tabs.get(tab.key);
    if (known !== undefined && (await run(['pane', 'get', known.rootPaneId])).code === 0) {
      return known.rootPaneId;
    }
    const workspace = await hostWorkspace();
    const created = await run([
      'tab',
      'create',
      ...(workspace === null ? [] : ['--workspace', workspace]),
      '--cwd',
      cwd,
      '--label',
      tab.label,
      '--no-focus',
    ]);
    if (created.code !== 0) {
      return targetPaneId;
    }
    try {
      const parsed: unknown = JSON.parse(created.stdout);
      const tabId = nested(parsed, ['result', 'tab', 'tab_id']);
      const rootPaneId = nested(parsed, ['result', 'root_pane', 'pane_id']);
      if (typeof tabId !== 'string' || typeof rootPaneId !== 'string') {
        return targetPaneId;
      }
      tabs.set(tab.key, { rootPaneId, tabId });
      saveTabs();
      return rootPaneId;
    } catch {
      return targetPaneId;
    }
  }

  async function closeTab(key: string): Promise<void> {
    const known = tabs.get(key);
    if (known === undefined) {
      return;
    }
    await run(['tab', 'close', known.tabId]);
    tabs.delete(key);
    saveTabs();
  }
  const pollMs = options?.pollMs ?? childPollMs;
  const watchers = new Map<string, () => void>();
  const startedAt = new Map<string, number>();
  const checks = new Set<() => void>();
  let events: PaneExitSource | null | undefined = options?.events;
  let metadataSeq = 0;

  function eventSource(): PaneExitSource | null {
    if (events !== undefined) {
      return events;
    }
    const socketPath = options?.socketPath ?? process.env['HERDR_SOCKET_PATH'] ?? '';
    if (socketPath.length === 0) {
      events = null;
      return null;
    }
    events = connectHerdrEvents({
      onReconnect: () => {
        for (const check of checks) {
          check();
        }
      },
      socketPath,
    });
    return events;
  }

  async function reportMetadata(paneId: string, spec: LaunchSpec): Promise<void> {
    metadataSeq += 1;
    try {
      await run(
        herdrMetadataArgs({
          paneId,
          purpose: spec.purpose,
          seq: metadataSeq,
          taskLabel: spec.taskLabel,
        }),
      );
    } catch {
      // A sidebar label must not fail the child.
    }
  }

  async function paneIsLive(paneId: string): Promise<boolean> {
    try {
      const listed = await run(herdrProcessInfoArgs(paneId));
      return paneProcessIsLive(listed.code, listed.stdout);
    } catch {
      return false;
    }
  }

  async function openPane(spec: LaunchSpec): Promise<RunStarted> {
    if (targetPaneId.length === 0) {
      throw new Error('HERDR_PANE_ID is required to launch a factory child');
    }
    writeMarkedPrompt(spec);
    clearSidecars(spec.sessionFile);
    const promptFile = `${spec.sessionFile}.prompt`;
    const scriptFile = `${spec.sessionFile}.sh`;
    writeFileSync(
      scriptFile,
      renderLaunchScript({
        handshakePath,
        model: spec.model,
        piBin,
        promptFile,
        runId: spec.runId,
        sessionFile: spec.sessionFile,
        thinking: spec.thinking,
        tools: spec.tools,
      }),
      { mode: 0o755 },
    );
    const opened = await run(
      herdrPaneArgs({
        cwd: spec.cwd,
        launchScript: scriptFile,
        targetPaneId: await splitTarget(spec.tab, spec.cwd),
      }),
    );
    if (opened.code !== 0) {
      throw new Error(opened.stderr.trim() || 'herdr pane open failed');
    }
    const paneId = parsePaneId(opened.stdout);
    if (paneId === null) {
      throw new Error('herdr did not return a pane id');
    }
    const renamed = await run(herdrRenameArgs(paneId, spec.paneName));
    if (renamed.code !== 0) {
      await run(['pane', 'close', paneId]);
      throw new Error(renamed.stderr.trim() || `herdr pane rename failed for ${paneId}`);
    }
    await reportMetadata(paneId, spec);
    return {
      paneId,
      paneName: spec.paneName,
      piSessionId: spec.sessionId,
      runId: spec.runId,
      sessionFile: spec.sessionFile,
    };
  }

  async function resume(spec: LaunchSpec): Promise<RunStarted> {
    const previous = spec.previousPaneId;
    if (previous !== null && (await paneIsLive(previous))) {
      const prompt = writeMarkedPrompt(spec);
      clearSidecars(spec.sessionFile);
      const prompted = await run(herdrAgentPromptArgs(previous, prompt));
      if (prompted.code !== 0) {
        throw new Error(prompted.stderr.trim() || 'herdr agent prompt failed');
      }
      await reportMetadata(previous, spec);
      return {
        paneId: previous,
        paneName: spec.paneName,
        piSessionId: spec.sessionId,
        runId: spec.runId,
        sessionFile: spec.sessionFile,
      };
    }
    if (previous !== null) {
      try {
        await run(['pane', 'close', previous]);
      } catch {
        // The dead pane is already gone.
      }
    }
    return openPane(spec);
  }

  async function openHandoffPane(spec: PaneSpec): Promise<{ paneId: string }> {
    if (targetPaneId.length === 0) {
      throw new Error('HERDR_PANE_ID is required to open a factory pane');
    }
    writeFileSync(
      spec.scriptFile,
      renderPaneScript({ cwd: spec.cwd, freshBin, piBin, target: spec.target }),
      { mode: 0o755 },
    );
    const opened = await run(
      herdrPaneArgs({
        cwd: spec.cwd,
        launchScript: spec.scriptFile,
        targetPaneId: await splitTarget(spec.tab, spec.cwd),
      }),
    );
    if (opened.code !== 0) {
      throw new Error(opened.stderr.trim() || 'herdr pane open failed');
    }
    const paneId = parsePaneId(opened.stdout);
    if (paneId === null) {
      throw new Error('herdr did not return a pane id');
    }
    const renamed = await run(herdrRenameArgs(paneId, spec.name));
    if (renamed.code !== 0) {
      throw new Error(renamed.stderr.trim() || `herdr pane rename failed for ${paneId}`);
    }
    return { paneId };
  }

  return {
    closeTab,
    interrupt: async () => undefined,
    launch: openPane,
    observe(active, handler) {
      const sessionFile = active.sessionFile;
      if (watchers.has(active.runId) || sessionFile === null) {
        return () => undefined;
      }
      startedAt.set(active.runId, Date.now());
      let paneGone = false;
      let bareExitSeen = false;
      let settled = false;
      let unwatch = noop;
      const stop = (): void => {
        clearInterval(timer);
        unwatch();
        checks.delete(check);
        watchers.delete(active.runId);
        startedAt.delete(active.runId);
      };
      const check = (): void => {
        if (settled) {
          return;
        }
        const openedAt = startedAt.get(active.runId) ?? Date.now();
        const jsonl = readOptional(sessionFile) ?? '';
        const classified = classifySidecar({
          exitCodeText: readOptional(`${sessionFile}.exitcode`),
          exitJson: takeExitJson(sessionFile, active.runId, jsonl),
          runId: active.runId,
          sessionEntryCount: jsonl.split('\n').filter((line) => line.length > 0).length,
          sessionText: jsonl,
          trigger: paneGone ? 'event' : 'sidecar',
          withinStartupWindow: Date.now() - openedAt < 15_000,
        });
        const terminal = toTerminal(
          classified,
          childOutput(classified, jsonl),
          usageFromSession(jsonl),
        );
        if (terminal === null) {
          return;
        }
        if (classified.kind === 'pane_killed' && !bareExitSeen) {
          bareExitSeen = true;
          return;
        }
        settled = true;
        stop();
        handler(terminal);
      };
      const timer = setInterval(check, pollMs);
      const source = eventSource();
      if (source !== null && active.paneId !== null) {
        unwatch = source.watch(active.paneId, () => {
          paneGone = true;
          check();
        });
      }
      checks.add(check);
      watchers.set(active.runId, stop);
      return stop;
    },
    openPane: openHandoffPane,
    async reconcile(runs) {
      const observations: Array<{ observation: ReconcileObservation; runId: RunId }> = [];
      for (const active of runs) {
        if (active.paneId === null || active.sessionFile === null) {
          observations.push({ observation: { kind: 'missing' }, runId: active.runId });
          continue;
        }
        const jsonl = readOptional(active.sessionFile) ?? '';
        const classified = classifySidecar({
          exitCodeText: readOptional(`${active.sessionFile}.exitcode`),
          exitJson: takeExitJson(active.sessionFile, active.runId, jsonl),
          runId: active.runId,
          sessionEntryCount: jsonl.split('\n').filter((line) => line.length > 0).length,
          sessionText: jsonl,
          trigger: 'gone',
          withinStartupWindow: false,
        });
        const usage = usageFromSession(jsonl);
        const terminal = toTerminal(classified, childOutput(classified, jsonl), usage);
        if (terminal !== null && classified.kind !== 'gap_exit') {
          observations.push({ observation: { kind: 'terminal', terminal }, runId: active.runId });
          continue;
        }
        const listed = await run(['pane', 'get', active.paneId]);
        if (listed.code === 0) {
          observations.push({
            observation: {
              kind: 'still_running',
              paneId: active.paneId,
              piSessionId: null,
              sessionFile: active.sessionFile,
            },
            runId: active.runId,
          });
        } else {
          observations.push({ observation: { kind: 'missing' }, runId: active.runId });
        }
      }
      return observations;
    },
    resume,
  };
}
