import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zeroUsage, type ReconcileObservation, type RunId, type TerminalOutcome, type UsageTotals } from "../domain.ts";
import type { FactorySubagentRuntime, LaunchSpec, RunStarted } from "./runtime.ts";
import { lastAssistantText } from "./session-activity.ts";

export type ClassifiedChild =
  | { kind: "pending" }
  | { kind: "caller_ping"; question: string }
  | { kind: "subagent_done" }
  | { kind: "completed_user_exit" }
  | { kind: "launch_failed"; message: string }
  | { kind: "crashed"; message: string }
  | { kind: "pane_killed" }
  | { kind: "gap_exit" };

export type SidecarInput = {
  exitCodeText: string | null;
  exitJson: string | null;
  runId: string;
  sessionEntryCount: number;
  trigger: "event" | "sidecar" | "gone";
  withinStartupWindow: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifySidecar(input: SidecarInput): ClassifiedChild {
  if (input.exitJson !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.exitJson);
    } catch {
      parsed = null;
    }
    if (isRecord(parsed) && parsed["type"] === "ping") {
      return { kind: "caller_ping", question: typeof parsed["message"] === "string" ? parsed["message"] : "" };
    }
    if (isRecord(parsed) && parsed["type"] === "done") {return { kind: "subagent_done" };}
  }
  if (input.exitCodeText !== null) {
    const [codeText, stamped] = input.exitCodeText.trim().split(/\s+/, 2);
    if (stamped !== undefined && stamped !== input.runId) {return { kind: "pending" };}
    const code = Number(codeText);
    if (!Number.isInteger(code)) {return { kind: "pending" };}
    if (code === 0) {return { kind: "completed_user_exit" };}
    if (input.withinStartupWindow && input.sessionEntryCount === 0) {
      return { kind: "launch_failed", message: `launch failed with exit code ${code}` };
    }
    return { kind: "crashed", message: `child crashed with exit code ${code}` };
  }
  if (input.trigger === "event") {return { kind: "pane_killed" };}
  if (input.trigger === "gone") {return { kind: "gap_exit" };}
  return { kind: "pending" };
}

export function herdrPaneArgs(input: { cwd: string; launchScript: string; targetPaneId: string; }): Array<string> {
  return [
    "plugin",
    "pane",
    "open",
    "--plugin",
    "pi-herdr-subagents",
    "--entrypoint",
    "argv",
    "--placement",
    "split",
    "--target-pane",
    input.targetPaneId,
    "--direction",
    "right",
    "--cwd",
    input.cwd,
    "--env",
    `PI_HERDR_LAUNCH_SCRIPT=${input.launchScript}`,
    "--no-focus",
  ];
}

export function renderLaunchScript(input: {
  model: string;
  piBin: string;
  promptFile: string;
  runId: string;
  sessionFile: string;
  subagentDonePath: string;
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
${shellQuote(input.piBin)} --session ${session} -e ${shellQuote(input.subagentDonePath)} --model ${shellQuote(input.model)} --thinking ${shellQuote(input.thinking)} --tools ${shellQuote(input.tools)} ${shellQuote(`@${input.promptFile}`)}
code=$?
printf "%s %s\\n" "$code" ${runId} > ${session}.exitcode
exit "$code"
`;
}

let cachedSubagentDonePath: string | null = null;

export function resolveSubagentDonePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["PI_HERDR_SUBAGENT_DONE"];
  if (override !== undefined && override.length > 0) {
    if (!existsSync(override)) {throw new Error(`subagent-done.ts was not found at ${override}`);}
    return override;
  }
  if (cachedSubagentDonePath !== null && existsSync(cachedSubagentDonePath)) {return cachedSubagentDonePath;}
  const root = path.join(os.homedir(), ".pi");
  const found = findNamed(root, "subagent-done.ts", 0);
  const hit = found[0];
  if (hit === undefined) {
    throw new Error(`subagent-done.ts was not found under ${root}. Set PI_HERDR_SUBAGENT_DONE to the pi-herdr-subagents file.`);
  }
  cachedSubagentDonePath = hit;
  return hit;
}

function findNamed(dir: string, name: string, depth: number): Array<string> {
  if (depth > 8 || !existsSync(dir)) {return [];}
  let entries: Array<{ isDirectory: () => boolean; isFile: () => boolean; name: string; }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const hits: Array<string> = [];
  for (const entry of entries) {
    if (entry.name === ".git") {continue;}
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) {hits.push(full);}
    else if (entry.isDirectory()) {hits.push(...findNamed(full, name, depth + 1));}
  }
  return hits;
}

export function herdrRenameArgs(paneId: string, label: string): Array<string> {
  return ["pane", "rename", paneId, label];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function usageFromSession(jsonl: string): UsageTotals {
  const usage = zeroUsage();
  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) {continue;}
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed["message"])) {continue;}
    const message = parsed["message"];
    if (!isRecord(message["usage"])) {continue;}
    const raw = message["usage"];
    usage.inputTokens = numberField(raw, "input");
    usage.outputTokens = numberField(raw, "output");
    usage.cacheReadTokens = numberField(raw, "cacheRead");
    usage.cacheWriteTokens = numberField(raw, "cacheWrite");
    usage.totalTokens = numberField(raw, "totalTokens");
    const cost = raw["cost"];
    if (isRecord(cost) && typeof cost["total"] === "number") {
      usage.costUsdMicros = Math.round(cost["total"] * 1_000_000);
    }
  }
  return usage;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function paneIdFrom(value: unknown): string | null {
  if (!isRecord(value)) {return null;}
  if (typeof value["pane_id"] === "string") {return value["pane_id"];}
  if (typeof value["paneId"] === "string") {return value["paneId"];}
  return paneIdFrom(value["pane"]) ?? paneIdFrom(value["plugin_pane"]) ?? paneIdFrom(value["result"]);
}

export function parsePaneId(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {return null;}
  const direct = paneIdFromJson(trimmed);
  if (direct !== null) {return direct;}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const embedded = paneIdFromJson(trimmed.slice(start, end + 1));
    if (embedded !== null) {return embedded;}
  }
  if (trimmed.includes("{")) {return null;}
  const line = trimmed.split("\n").find((item) => item.trim().length > 0);
  return line === undefined ? null : line.trim();
}

function paneIdFromJson(text: string): string | null {
  try {
    return paneIdFrom(JSON.parse(text));
  } catch {
    return null;
  }
}

type CommandResult = { code: number; stderr: string; stdout: string; };
type CommandRunner = (args: Array<string>) => Promise<CommandResult>;

function defaultRunner(args: Array<string>): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("herdr", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stderr, stdout });
    });
  });
}

function readOptional(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function childOutput(classified: ClassifiedChild, jsonl: string): string {
  if (classified.kind === "subagent_done") {return lastAssistantText(jsonl);}
  return jsonl;
}

function toTerminal(classified: ClassifiedChild, output: string, usage: UsageTotals): TerminalOutcome | null {
  switch (classified.kind) {
    case "pending":
      return null;
    case "subagent_done":
      return { kind: "subagent_done", output, usage };
    case "caller_ping":
      return { kind: "caller_ping", question: classified.question, usage };
    case "completed_user_exit":
      return { kind: "completed_user_exit", message: output || "child exited without subagent_done" };
    case "launch_failed":
      return { kind: "launch_failed", message: classified.message };
    case "crashed":
      return { kind: "crashed", message: classified.message };
    case "pane_killed":
      return { kind: "pane_killed", message: "pane killed" };
    case "gap_exit":
      return { kind: "gap_exit", message: "child ended while the event stream was down" };
    default: {
      const _exhaustive: never = classified;
      return _exhaustive;
    }
  }
}

export function createPiHerdrRuntime(options?: { piBin?: string; run?: CommandRunner; targetPaneId?: string }): FactorySubagentRuntime {
  const run = options?.run ?? defaultRunner;
  const piBin = options?.piBin ?? "pi";
  const targetPaneId = options?.targetPaneId ?? process.env["HERDR_PANE_ID"] ?? "";
  const watchers = new Map<string, ReturnType<typeof setInterval>>();
  const startedAt = new Map<string, number>();

  async function openPane(spec: LaunchSpec): Promise<RunStarted> {
    if (targetPaneId.length === 0) {throw new Error("HERDR_PANE_ID is required to launch a factory child");}
    const directory = path.dirname(spec.sessionFile);
    mkdirSync(directory, { recursive: true });
    const promptFile = `${spec.sessionFile}.prompt`;
    const scriptFile = `${spec.sessionFile}.sh`;
    writeFileSync(promptFile, spec.prompt);
    writeFileSync(scriptFile, renderLaunchScript({
      model: spec.model,
      piBin,
      promptFile,
      runId: spec.runId,
      sessionFile: spec.sessionFile,
      subagentDonePath: resolveSubagentDonePath(),
      thinking: spec.thinking,
      tools: spec.tools,
    }), { mode: 0o755 });
    const opened = await run(herdrPaneArgs({ cwd: spec.cwd, launchScript: scriptFile, targetPaneId }));
    if (opened.code !== 0) {throw new Error(opened.stderr.trim() || "herdr pane open failed");}
    const paneId = parsePaneId(opened.stdout);
    if (paneId === null) {throw new Error("herdr did not return a pane id");}
    const renamed = await run(herdrRenameArgs(paneId, spec.paneName));
    if (renamed.code !== 0) {
      await run(["pane", "close", paneId]);
      throw new Error(renamed.stderr.trim() || `herdr pane rename failed for ${paneId}`);
    }
    return { paneId, paneName: spec.paneName, piSessionId: spec.sessionId, runId: spec.runId, sessionFile: spec.sessionFile };
  }

  return {
    interrupt: async () => undefined,
    launch: openPane,
    observe(active, handler) {
      if (watchers.has(active.runId) || active.sessionFile === null) {return () => undefined;}
      startedAt.set(active.runId, Date.now());
      const timer = setInterval(() => {
        const sessionFile = active.sessionFile;
        if (sessionFile === null) {return;}
        const openedAt = startedAt.get(active.runId) ?? Date.now();
        const classified = classifySidecar({
          exitCodeText: readOptional(`${sessionFile}.exitcode`),
          exitJson: readOptional(`${sessionFile}.exit`),
          runId: active.runId,
          sessionEntryCount: readOptional(sessionFile)?.split("\n").filter((line) => line.length > 0).length ?? 0,
          trigger: "sidecar",
          withinStartupWindow: Date.now() - openedAt < 15_000,
        });
        const jsonl = readOptional(sessionFile) ?? "";
        const terminal = toTerminal(classified, childOutput(classified, jsonl), usageFromSession(jsonl));
        if (terminal === null) {return;}
        clearInterval(timer);
        watchers.delete(active.runId);
        startedAt.delete(active.runId);
        handler(terminal);
      }, 1000);
      watchers.set(active.runId, timer);
      return () => {
        clearInterval(timer);
        watchers.delete(active.runId);
        startedAt.delete(active.runId);
      };
    },
    async reconcile(runs) {
      const observations: Array<{ observation: ReconcileObservation; runId: RunId; }> = [];
      for (const active of runs) {
        if (active.paneId === null || active.sessionFile === null) {
          observations.push({ observation: { kind: "missing" }, runId: active.runId });
          continue;
        }
        const classified = classifySidecar({
          exitCodeText: readOptional(`${active.sessionFile}.exitcode`),
          exitJson: readOptional(`${active.sessionFile}.exit`),
          runId: active.runId,
          sessionEntryCount: 1,
          trigger: "gone",
          withinStartupWindow: false,
        });
        const jsonl = readOptional(active.sessionFile) ?? "";
        const usage = usageFromSession(jsonl);
        const terminal = toTerminal(classified, childOutput(classified, jsonl), usage);
        if (terminal !== null && classified.kind !== "gap_exit") {
          observations.push({ observation: { kind: "terminal", terminal }, runId: active.runId });
          continue;
        }
        const listed = await run(["pane", "get", active.paneId]);
        if (listed.code === 0) {
          observations.push({
            observation: { kind: "still_running", paneId: active.paneId, piSessionId: null, sessionFile: active.sessionFile },
            runId: active.runId,
          });
        } else {
          observations.push({ observation: { kind: "missing" }, runId: active.runId });
        }
      }
      return observations;
    },
    resume: openPane,
  };
}
