import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { taskId, type PlanValidationOutcome, type PlannedTask } from "../domain.ts";
import { sha256 } from "../hash.ts";

export type ParsedPlanTask = { blockedBy: Array<string>; id: string; path: string; };

export type ParsedPlan =
  | { failures: Array<string>; kind: "invalid"; }
  | {
      blocker: string | null;
      kind: "valid";
      planPath: string;
      ready: Array<string>;
      status: "planned" | "blocked";
      tasks: Array<ParsedPlanTask>;
    };

function section(markdown: string, heading: string): string | null {
  const pattern = new RegExp(`^## ${heading}\\s*$`, "m");
  const match = pattern.exec(markdown);
  if (match === null || match.index === undefined) {return null;}
  const rest = markdown.slice(match.index + match[0].length);
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function field(body: string | null): string | null {
  if (body === null) {return null;}
  const line = body
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith("-"));
  return line ?? null;
}

export function parsePlanTemplate(output: string): ParsedPlan {
  const text = output.trim();
  const failures: Array<string> = [];
  if (!text.startsWith("## Status")) {failures.push("Output must start with the factory.plan.v3 template.");}
  const status = field(section(text, "Status"));
  if (status !== "planned" && status !== "blocked") {failures.push("Status must be planned or blocked.");}
  const artifacts = section(text, "Artifacts");
  const planMatch = artifacts?.match(/^-\s+plan:\s+(\S+)\s*$/m);
  const planPath = planMatch?.[1];
  if (planPath === undefined) {failures.push("Artifacts must include a plan path.");}
  const tasks: Array<ParsedPlanTask> = [];
  const seen = new Set<string>();
  for (const match of artifacts?.matchAll(/^\s*-\s+(\d+):\s+(\S+)\s+\(pending,\s+blockedBy\s+([^)]+)\)\s*$/gm) ?? []) {
    const id = match[1];
    const taskPath = match[2];
    const blocked = match[3];
    if (id === undefined || taskPath === undefined || blocked === undefined) {continue;}
    if (seen.has(id)) {failures.push(`Task ${id} is listed more than once.`);}
    seen.add(id);
    const blockedBy =
      blocked.trim() === "none"
        ? []
        : blocked
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0 && item !== "none");
    tasks.push({ blockedBy, id, path: taskPath });
  }
  if (tasks.length === 0) {failures.push("Artifacts must list at least one task.");}
  const readyBody = section(text, "Ready");
  const ready =
    readyBody === null || readyBody === "none"
      ? []
      : readyBody
          .split(/[,\s]+/)
          .map((item) => item.trim())
          .filter((item) => item.length > 0 && item !== "none");
  const blockerBody = field(section(text, "Blocker"));
  if (blockerBody === null) {failures.push("Blocker section is required.");}
  if (failures.length > 0 || status === null || planPath === undefined || blockerBody === null) {
    return { failures, kind: "invalid" };
  }
  if (status !== "planned" && status !== "blocked") {return { failures: ["Status must be planned or blocked."], kind: "invalid" };}
  return {
    blocker: blockerBody === "none" ? null : blockerBody,
    kind: "valid",
    planPath,
    ready,
    status,
    tasks,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsedPlanFromJson(raw: string): Extract<ParsedPlan, { kind: "valid" }> | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value["contract"] !== "factory.plan.v3") {return null;}
  const status = value["status"];
  const planPath = value["planPath"];
  const taskList = value["tasks"];
  const readyList = value["ready"];
  const blockerValue = value["blocker"];
  if (status !== "planned" && status !== "blocked") {return null;}
  if (typeof planPath !== "string" || !Array.isArray(taskList) || !Array.isArray(readyList)) {return null;}
  if (blockerValue !== null && typeof blockerValue !== "string") {return null;}
  const tasks: Array<ParsedPlanTask> = [];
  for (const task of taskList) {
    if (!isRecord(task)) {return null;}
    const id = task["id"];
    const taskPath = task["path"];
    const deps = task["blockedBy"];
    if (typeof id !== "string" || typeof taskPath !== "string" || !Array.isArray(deps)) {return null;}
    const blockedBy: Array<string> = [];
    for (const dep of deps) {
      if (typeof dep !== "string") {return null;}
      blockedBy.push(dep);
    }
    tasks.push({ blockedBy, id, path: taskPath });
  }
  const ready: Array<string> = [];
  for (const item of readyList) {
    if (typeof item !== "string") {return null;}
    ready.push(item);
  }
  return {
    blocker: typeof blockerValue === "string" ? blockerValue : null,
    kind: "valid",
    planPath,
    ready,
    status,
    tasks,
  };
}

export function canonicalPlanJson(plan: Extract<ParsedPlan, { kind: "valid" }>): string {
  return JSON.stringify({
    blocker: plan.blocker,
    contract: "factory.plan.v3",
    planPath: plan.planPath,
    ready: plan.ready,
    status: plan.status,
    tasks: plan.tasks.map((task) => ({ blockedBy: task.blockedBy, id: task.id, path: task.path })),
  });
}

function blockedBy(markdown: string): Array<string> | null {
  const match = /^Blocked by:\s*(.+)$/m.exec(markdown);
  const value = match?.[1]?.trim();
  if (value === undefined) {return null;}
  if (value === "none") {return [];}
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function titleOf(markdown: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim() || fallback;
}

const taskFilePattern = /^(\d+)-task-.+\.md$/;

export function inspectPlanDir(input: { factoryDir: string }): PlanValidationOutcome {
  const failures: Array<string> = [];
  const planFile = path.join(input.factoryDir, "plan.md");
  let planText: string | null = null;
  try {
    planText = readFileSync(planFile, "utf8");
  } catch {
    planText = null;
  }
  if (planText === null || planText.trim().length === 0) {failures.push("plan.md is missing.");}

  let filenames: Array<string> = [];
  try {
    filenames = readdirSync(input.factoryDir).filter((name) => taskFilePattern.test(name)).sort();
  } catch {
    failures.push(`Ticket directory ${input.factoryDir} cannot be read.`);
  }
  if (filenames.length === 0) {failures.push("At least one task file is required.");}
  if (failures.length > 0) {return { failures, kind: "failed" };}

  const tasks: Array<PlannedTask> = [];
  for (const filename of filenames) {
    const id = taskFilePattern.exec(filename)?.[1] ?? String(tasks.length + 1);
    let text = "";
    try {
      text = readFileSync(path.join(input.factoryDir, filename), "utf8");
    } catch {
      text = "";
    }
    const deps = blockedBy(text) ?? [];
    tasks.push({
      blockedBy: deps.map((dep) => taskId(dep)),
      ordinal: Number(id),
      specHash: sha256(text),
      taskFile: filename,
      taskId: taskId(id),
      title: titleOf(text, `Task ${id}`),
    });
  }
  return { kind: "passed", planPath: planFile, tasks };
}

export type ValidationCheckDraft = {
  details: string;
  kind: "artifact" | "schema" | "policy";
  name: string;
  status: "passed" | "failed";
};

export function planChecks(outcome: PlanValidationOutcome): Array<ValidationCheckDraft> {
  if (outcome.kind === "failed") {
    return outcome.failures.map((failure) => ({
      details: failure,
      kind: "artifact",
      name: failure,
      status: "failed",
    }));
  }
  return [
    { details: outcome.planPath, kind: "artifact", name: "plan.md", status: "passed" },
    {
      details: String(outcome.tasks.length),
      kind: "schema",
      name: "task graph",
      status: "passed",
    },
  ];
}
