#!/usr/bin/env node
/**
 * Factory-state CLI. Mutate .factory/db/state.sqlite with a revision check
 * and a single SQLite transaction. Do not edit the database by hand.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CliError, EXIT_ARGS, EXIT_INVALID, EXIT_IO, EXIT_NOT_FOUND, EXIT_OK } from "./errors.mjs";
import { startServer } from "./server.mjs";
import { loadState, mutate, openStore } from "./store.mjs";

export { EXIT_ARGS, EXIT_INVALID, EXIT_IO, EXIT_NOT_FOUND, EXIT_OK, CliError };

const STAGES = new Set(["plan", "work", "review", "wrapup", "done"]);
const TICKET_STATUSES = new Set(["active", "waiting_for_user", "blocked", "failed", "complete"]);
const TASK_STATUSES = new Set(["pending", "in_progress", "ready_for_review", "in_review", "done", "blocked"]);
const SESSION_STATUSES = new Set([
  "starting",
  "running",
  "waiting_for_user",
  "completed",
  "failed",
  "closed",
]);
const VERDICTS = new Set(["approve", "changes_requested", "blocked"]);
const OWNERS = new Set(["user", "agent", "external"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MODEL_ROLES = ["plan", "work", "review", "wrapup"];
const TRIAGE_ROLES = ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"];
const FACTORY_JSON_KEYS = new Set([
  "schemaVersion",
  "ticketIdPattern",
  "models",
  "limits",
  "github",
  "hooks",
  "verification",
]);
const DEFAULT_TICKET_PATTERN = "PROJ-<number>";
const DEFAULT_LIMITS = { maxTickets: 2, maxAgents: 4, reviewRounds: 3 };
const TASK_EDGES = {
  pending: new Set(["in_progress", "blocked"]),
  in_progress: new Set(["ready_for_review", "blocked"]),
  ready_for_review: new Set(["in_review", "blocked"]),
  in_review: new Set(["in_progress", "done", "blocked"]),
  blocked: new Set(["pending", "in_progress"]),
  done: new Set(),
};
const ACTIVE_TASK_STATUSES = new Set(["in_progress", "ready_for_review", "in_review", "blocked"]);

const OPTION_SPEC = {
  help: { type: "boolean", short: "h" },
  ticket: { type: "string" },
  title: { type: "string" },
  type: { type: "string" },
  "source-kind": { type: "string" },
  "source-ref": { type: "string" },
  "expected-revision": { type: "string" },
  stage: { type: "string" },
  status: { type: "string" },
  task: { type: "string" },
  round: { type: "string" },
  verdict: { type: "string" },
  "finding-count": { type: "string" },
  "blocking-count": { type: "string" },
  "session-id": { type: "string" },
  session: { type: "string" },
  pane: { type: "string" },
  "pane-name": { type: "string" },
  text: { type: "string" },
  reason: { type: "string" },
  owner: { type: "string" },
  "factory-root": { type: "string" },
  "worktree-path": { type: "string" },
  branch: { type: "string" },
  "base-branch": { type: "string" },
  "workspace-id": { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  "ticket-id-pattern": { type: "string" },
  "plan-model": { type: "string" },
  "plan-thinking": { type: "string" },
  "work-model": { type: "string" },
  "work-thinking": { type: "string" },
  "review-model": { type: "string" },
  "review-thinking": { type: "string" },
  "wrapup-model": { type: "string" },
  "wrapup-thinking": { type: "string" },
  "arbiter-model": { type: "string" },
  "arbiter-thinking": { type: "string" },
  "github-repo": { type: "string" },
  "pull-requests": { type: "string" },
  "github-cli": { type: "string" },
  label: { type: "string", multiple: true },
  parent: { type: "string" },
  kind: { type: "string" },
  "depends-on": { type: "string", multiple: true },
  artifact: { type: "string" },
  "verification-profile": { type: "string" },
  evidence: { type: "string" },
  "subagent-id": { type: "string" },
  repo: { type: "string" },
};

const USAGE_LINE = "node cli.mjs <command> [options]";
const FACTORY_ROOT_NOTE = "Else FACTORY_ROOT, else <git-toplevel>/.factory";

const COMMANDS = [
  {
    name: "help",
    mutation: false,
    summary: "Print this command catalog as JSON. Pass a command name to filter.",
    required: [],
    optional: [],
  },
  {
    name: "init",
    mutation: false,
    summary: "Write FACTORY.json, github.md when a repo is set, the tickets directory, the Git exclude line, missing role agents in ~/.pi/agent/agents/, and the empty SQLite store. Does not insert a ticket or overwrite an existing agent file.",
    required: [],
    optional: [
      "--ticket-id-pattern",
      "--plan-model",
      "--plan-thinking",
      "--work-model",
      "--work-thinking",
      "--review-model",
      "--review-thinking",
      "--wrapup-model",
      "--wrapup-thinking",
      "--arbiter-model",
      "--arbiter-thinking",
      "--github-repo",
      "--pull-requests",
      "--github-cli",
      "--label",
    ],
  },
  {
    name: "create",
    mutation: true,
    summary: "Create a ticket at stage plan, status active.",
    required: ["--ticket", "--expected-revision"],
    optional: [
      "--title",
      "--type",
      "--source-kind",
      "--source-ref",
      "--worktree-path",
      "--branch",
      "--base-branch",
      "--workspace-id",
      "--parent",
      "--kind",
    ],
  },
  {
    name: "status",
    mutation: false,
    summary: "Print ticket state as JSON.",
    required: [],
    optional: ["--ticket"],
  },
  {
    name: "transition",
    mutation: true,
    summary: "Set ticket stage and status.",
    required: ["--ticket", "--stage", "--status", "--expected-revision"],
    optional: [],
    flagEnums: { "--stage": "stage", "--status": "ticketStatus" },
  },
  {
    name: "task transition",
    mutation: true,
    summary: "Move an existing task along the legal status graph. Does not create tasks.",
    required: ["--ticket", "--task", "--status", "--expected-revision"],
    optional: [],
    flagEnums: { "--status": "taskStatus" },
  },
  {
    name: "task register",
    mutation: true,
    summary: "Declare a pending task and its dependencies without changing currentTask.",
    required: ["--ticket", "--task", "--expected-revision"],
    optional: ["--depends-on", "--artifact", "--source-ref", "--verification-profile", "--evidence"],
  },
  {
    name: "ticket depend",
    mutation: true,
    summary: "Record that a ticket depends on another ticket.",
    required: ["--ticket", "--depends-on", "--expected-revision"],
    optional: [],
  },
  {
    name: "review record",
    mutation: true,
    summary: "Record a review verdict for a task.",
    required: [
      "--ticket",
      "--task",
      "--round",
      "--verdict",
      "--finding-count",
      "--blocking-count",
      "--expected-revision",
    ],
    optional: [],
    flagEnums: { "--verdict": "verdict" },
  },
  {
    name: "session record",
    mutation: true,
    summary: "Upsert a session row.",
    required: [
      "--ticket",
      "--session-id",
      "--session",
      "--stage",
      "--status",
      "--expected-revision",
    ],
    optional: ["--task", "--round", "--pane", "--pane-name", "--subagent-id"],
    flagEnums: { "--stage": "stage", "--status": "sessionStatus" },
  },
  {
    name: "message",
    mutation: true,
    summary: "Set the latest meaningful ticket message.",
    required: ["--ticket", "--text", "--expected-revision"],
    optional: [],
  },
  {
    name: "block",
    mutation: true,
    summary: "Mark the ticket blocked.",
    required: ["--ticket", "--reason", "--expected-revision"],
    optional: ["--owner", "--task"],
    flagEnums: { "--owner": "owner" },
  },
  {
    name: "unblock",
    mutation: true,
    summary: "Clear the blocker and restore active if blocked.",
    required: ["--ticket", "--expected-revision"],
    optional: [],
  },
  {
    name: "usage record",
    mutation: true,
    summary: "Persist billed usage from a Pi session file.",
    required: ["--ticket", "--stage", "--session", "--expected-revision"],
    optional: ["--task", "--round"],
    flagEnums: { "--stage": "stage" },
  },
  {
    name: "usage show",
    mutation: false,
    summary: "Summarize recorded usage.",
    required: [],
    optional: ["--ticket", "--stage"],
    flagEnums: { "--stage": "stage" },
  },
  {
    name: "validate",
    mutation: false,
    summary: "Check schemaVersion and enum values.",
    required: [],
    optional: [],
  },
  {
    name: "server",
    mutation: false,
    summary: "Serve SSE events for dashboards.",
    required: [],
    optional: ["--host", "--port"],
  },
  {
    name: "worktree path",
    mutation: false,
    summary: "Print the external worktree path for a ticket.",
    required: ["--repo", "--ticket"],
    optional: [],
  },
  {
    name: "github reconcile",
    mutation: false,
    summary: "Print GitHub comment and label commands derived from ticket state.",
    required: ["--ticket"],
    optional: [],
  },
];

const USAGE = `Usage: ${USAGE_LINE}

Commands:
${COMMANDS.map((command) => `  ${command.name}`).join("\n")}

Global:
  --factory-root <path>   ${FACTORY_ROOT_NOTE}

Server:
  --host <addr>           Default 127.0.0.1
  --port <n>              Default 8787
`;

const OP_NAMES = {
  create: "create",
  transition: "transition",
  "task transition": "task_transition",
  "task register": "task_register",
  "ticket depend": "ticket_depend",
  "review record": "review_record",
  "session record": "session_record",
  message: "message",
  block: "block",
  unblock: "unblock",
  "usage record": "usage_record",
};

function writeLine(stream, text) {
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

function printJson(stdout, value) {
  writeLine(stdout, JSON.stringify(value, null, 2));
}

function catalogEntry(command) {
  return {
    name: command.name,
    mutation: command.mutation,
    summary: command.summary,
    required: command.required,
    optional: command.optional,
    ...(command.flagEnums ? { flagEnums: command.flagEnums } : {}),
  };
}

function helpTopic(command, helpFlag) {
  if (command === "help") {
    return null;
  }
  if (command.startsWith("help ")) {
    return command.slice("help ".length);
  }
  if (helpFlag && command) {
    return command;
  }
  return null;
}

function helpPayload(topic) {
  const selected = topic ? COMMANDS.filter((command) => command.name === topic) : COMMANDS;
  if (topic && selected.length === 0) {
    throw new CliError(`unknown command: ${topic}`, EXIT_ARGS);
  }
  return {
    ok: true,
    usage: USAGE_LINE,
    global: [{ flag: "--factory-root", required: false, note: FACTORY_ROOT_NOTE }],
    enums: {
      stage: [...STAGES],
      ticketStatus: [...TICKET_STATUSES],
      taskStatus: [...TASK_STATUSES],
      sessionStatus: [...SESSION_STATUSES],
      verdict: [...VERDICTS],
      owner: [...OWNERS],
      thinking: [...THINKING_LEVELS],
      triageRole: [...TRIAGE_ROLES],
    },
    commands: selected.map(catalogEntry),
  };
}

function requireOpt(values, name) {
  const value = values[name];
  if (value === undefined || value === "") {
    throw new CliError(`--${name} is required`, EXIT_ARGS);
  }
  return value;
}

function optionalInt(values, name) {
  const value = values[name];
  if (value === undefined || value === "") {
    return null;
  }
  if (!/^-?\d+$/.test(value)) {
    throw new CliError(`--${name} must be an integer`, EXIT_ARGS);
  }
  return Number(value);
}

function requireInt(values, name) {
  requireOpt(values, name);
  const parsed = optionalInt(values, name);
  if (parsed === null) {
    throw new CliError(`--${name} is required`, EXIT_ARGS);
  }
  return parsed;
}

function requireEnum(name, value, allowed) {
  if (!allowed.has(value)) {
    throw new CliError(`--${name} must be one of ${[...allowed].join(", ")}`, EXIT_ARGS);
  }
  return value;
}

function codeRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new CliError("cannot determine code root (git rev-parse --show-toplevel)", EXIT_IO);
  }
  return result.stdout.trim();
}

export function resolveFactoryRoot(flag, env = process.env) {
  const override = flag || env.FACTORY_ROOT;
  if (!override) {
    return path.join(codeRoot(), ".factory");
  }
  return path.isAbsolute(override) ? override : path.resolve(codeRoot(), override);
}

function emptyReview(round = null) {
  return {
    round,
    verdict: null,
    findingCount: null,
    blockingCount: null,
    updatedAt: null,
  };
}

function emptyTicket(values, ts) {
  const sourceKind = values["source-kind"];
  const sourceRef = values["source-ref"];
  let source = null;
  if (sourceKind || sourceRef) {
    source = { kind: sourceKind ?? null, ref: sourceRef ?? null };
  }
  let worktree = null;
  if (values["worktree-path"] || values.branch || values["base-branch"] || values["workspace-id"]) {
    worktree = {
      path: values["worktree-path"] ?? null,
      branch: values.branch ?? null,
      baseBranch: values["base-branch"] ?? null,
      workspaceId: values["workspace-id"] ?? null,
    };
  }
  return {
    title: values.title ?? null,
    type: values.type ?? null,
    source,
    stage: "plan",
    status: "active",
    currentTask: null,
    message: null,
    messageAt: null,
    blocker: null,
    createdAt: ts,
    updatedAt: ts,
    worktree,
    parent: values.parent ?? null,
    kind: values.kind ?? null,
    dependsOn: [],
    hooks: [],
    tasks: {},
    sessions: {},
    usage: {},
  };
}

function emptyTask(ts, values = {}) {
  return {
    status: "pending",
    blockedBy: listOpt(values, "depends-on"),
    review: emptyReview(),
    updatedAt: ts,
    artifact: values.artifact ?? null,
    sourceRef: values["source-ref"] ?? null,
    verificationProfile: values["verification-profile"] ?? null,
    evidencePath: values.evidence ?? null,
  };
}

function listOpt(values, name) {
  const raw = values[name];
  if (raw === undefined) {
    return [];
  }
  return (Array.isArray(raw) ? raw : [raw]).filter((item) => typeof item === "string" && item);
}

function ticketOf(state, id) {
  const ticket = state.tickets[id];
  if (!ticket) {
    throw new CliError(`ticket not found: ${id}`, EXIT_NOT_FOUND);
  }
  return ticket;
}

function collectEnumError(label, value, allowed, errors) {
  if (value == null) {
    return;
  }
  if (!allowed.has(value)) {
    errors.push(`${label} has invalid value ${JSON.stringify(value)}`);
  }
}

function validateState(state) {
  const errors = [];
  if (state.schemaVersion !== 4) {
    errors.push(`unsupported schemaVersion ${state.schemaVersion}`);
  }
  if (typeof state.revision !== "number" || !Number.isInteger(state.revision)) {
    errors.push("revision must be an integer");
  }
  if (!state.tickets || typeof state.tickets !== "object" || Array.isArray(state.tickets)) {
    errors.push("tickets must be an object");
    return errors;
  }
  for (const [id, ticket] of Object.entries(state.tickets)) {
    if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) {
      errors.push(`tickets.${id} must be an object`);
      continue;
    }
    collectEnumError(`tickets.${id}.stage`, ticket.stage, STAGES, errors);
    collectEnumError(`tickets.${id}.status`, ticket.status, TICKET_STATUSES, errors);
    if (ticket.blocker && typeof ticket.blocker === "object") {
      collectEnumError(`tickets.${id}.blocker.owner`, ticket.blocker.owner, OWNERS, errors);
    }
    const tasks = ticket.tasks;
    if (tasks && typeof tasks === "object" && !Array.isArray(tasks)) {
      for (const [taskId, task] of Object.entries(tasks)) {
        if (!task || typeof task !== "object") {
          errors.push(`tickets.${id}.tasks.${taskId} must be an object`);
          continue;
        }
        collectEnumError(`tickets.${id}.tasks.${taskId}.status`, task.status, TASK_STATUSES, errors);
        if (task.review && typeof task.review === "object") {
          collectEnumError(
            `tickets.${id}.tasks.${taskId}.review.verdict`,
            task.review.verdict,
            VERDICTS,
            errors,
          );
        }
      }
    } else if (tasks != null) {
      errors.push(`tickets.${id}.tasks must be an object`);
    }
    const sessions = ticket.sessions;
    if (sessions && typeof sessions === "object" && !Array.isArray(sessions)) {
      for (const [sid, session] of Object.entries(sessions)) {
        if (!session || typeof session !== "object") {
          errors.push(`tickets.${id}.sessions.${sid} must be an object`);
          continue;
        }
        collectEnumError(`tickets.${id}.sessions.${sid}.stage`, session.stage, STAGES, errors);
        collectEnumError(
          `tickets.${id}.sessions.${sid}.status`,
          session.status,
          SESSION_STATUSES,
          errors,
        );
      }
    } else if (sessions != null) {
      errors.push(`tickets.${id}.sessions must be an object`);
    }
  }
  return errors;
}

function emptyAgg() {
  return {
    sessions: 0,
    models: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: 0,
  };
}

function addUsage(agg, record) {
  agg.sessions += 1;
  if (typeof record.model === "string" && record.model && !agg.models.includes(record.model)) {
    agg.models.push(record.model);
  }
  const tokens = record.tokens && typeof record.tokens === "object" ? record.tokens : {};
  agg.tokens.input += Number(tokens.input) || 0;
  agg.tokens.output += Number(tokens.output) || 0;
  agg.tokens.cacheRead += Number(tokens.cacheRead) || 0;
  agg.tokens.cacheWrite += Number(tokens.cacheWrite) || 0;
  agg.tokens.total += Number(tokens.total) || 0;
  agg.costUsd += Number(record.costUsd) || 0;
}

function cloneAgg(agg) {
  return {
    sessions: agg.sessions,
    models: [...agg.models],
    tokens: { ...agg.tokens },
    costUsd: agg.costUsd,
  };
}

function summarizeUsage(tickets, { ticketId = null, stage = null } = {}) {
  const selected = ticketId ? { [ticketId]: ticketOf({ tickets }, ticketId) } : tickets;
  const byTicket = {};
  const total = emptyAgg();
  for (const [id, ticket] of Object.entries(selected)) {
    const stages = {};
    const tasks = {};
    const models = {};
    const ticketTotal = emptyAgg();
    const usage = ticket.usage && typeof ticket.usage === "object" ? ticket.usage : {};
    for (const record of Object.values(usage)) {
      if (!record || typeof record !== "object") {
        continue;
      }
      if (stage && record.stage !== stage) {
        continue;
      }
      const stageKey = record.stage || "unknown";
      stages[stageKey] ??= emptyAgg();
      addUsage(stages[stageKey], record);
      if (record.task) {
        tasks[record.task] ??= emptyAgg();
        addUsage(tasks[record.task], record);
      }
      if (record.model) {
        models[record.model] ??= emptyAgg();
        addUsage(models[record.model], record);
      }
      addUsage(ticketTotal, record);
      addUsage(total, record);
    }
    byTicket[id] = { stages, tasks, models, total: cloneAgg(ticketTotal) };
  }
  return { tickets: byTicket, total };
}

function readUsageFromSession(sessionFile) {
  const reader = path.join(import.meta.dirname, "..", "pi-session-reader.py");
  const result = spawnSync("python3", [reader, "usage", sessionFile], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "pi-session-reader.py usage failed").trim();
    throw new CliError(detail, result.status === EXIT_NOT_FOUND ? EXIT_NOT_FOUND : EXIT_IO);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new CliError(`invalid usage JSON from reader: ${err.message}`, EXIT_INVALID);
  }
}

function cmdCreate(state, values, ts) {
  const ticketId = requireOpt(values, "ticket");
  if (state.tickets[ticketId]) {
    throw new CliError(`ticket already exists: ${ticketId}`, EXIT_INVALID);
  }
  if (values.kind) {
    requireEnum("kind", values.kind, new Set(["umbrella", "concrete"]));
  }
  if (values.parent && !state.tickets[values.parent]) {
    throw new CliError(`parent ticket not found: ${values.parent}`, EXIT_NOT_FOUND);
  }
  const ticket = emptyTicket(values, ts);
  state.tickets[ticketId] = ticket;
  return { ticket: ticketId, stage: ticket.stage, status: ticket.status, kind: ticket.kind };
}

function cmdTransition(state, values, ts) {
  const ticketId = requireOpt(values, "ticket");
  const ticket = ticketOf(state, ticketId);
  ticket.stage = requireEnum("stage", requireOpt(values, "stage"), STAGES);
  ticket.status = requireEnum("status", requireOpt(values, "status"), TICKET_STATUSES);
  ticket.updatedAt = ts;
  return { ticket: ticketId, stage: ticket.stage, status: ticket.status };
}

function applyCurrentTask(ticket, taskId, status) {
  if (ACTIVE_TASK_STATUSES.has(status)) {
    ticket.currentTask = taskId;
    return;
  }
  if (ticket.currentTask === taskId) {
    ticket.currentTask = null;
  }
}

function cmdTaskRegister(state, values, ts) {
  const ticketId = requireOpt(values, "ticket");
  const taskId = requireOpt(values, "task");
  const ticket = ticketOf(state, ticketId);
  const blockedBy = listOpt(values, "depends-on");
  const existing = ticket.tasks[taskId];
  if (existing) {
    const sameDeps =
      JSON.stringify([...(existing.blockedBy || [])].sort()) === JSON.stringify([...blockedBy].sort());
    const sameMeta =
      (existing.artifact ?? null) === (values.artifact ?? existing.artifact ?? null) &&
      (existing.sourceRef ?? null) === (values["source-ref"] ?? existing.sourceRef ?? null) &&
      (existing.verificationProfile ?? null) ===
        (values["verification-profile"] ?? existing.verificationProfile ?? null);
    if (existing.status !== "pending" || !sameDeps || !sameMeta) {
      throw new CliError(`task already registered with different state: ${ticketId} ${taskId}`, EXIT_INVALID);
    }
    return { ticket: ticketId, task: taskId, status: existing.status, currentTask: ticket.currentTask };
  }
  ticket.tasks[taskId] = emptyTask(ts, values);
  ticket.updatedAt = ts;
  return { ticket: ticketId, task: taskId, status: "pending", currentTask: ticket.currentTask };
}

function cmdTaskTransition(state, values, ts) {
  const ticketId = requireOpt(values, "ticket");
  const taskId = requireOpt(values, "task");
  const ticket = ticketOf(state, ticketId);
  const status = requireEnum("status", requireOpt(values, "status"), TASK_STATUSES);
  const task = ticket.tasks[taskId];
  if (!task) {
    throw new CliError(`task not found: ${ticketId} ${taskId}; register it first`, EXIT_NOT_FOUND);
  }
  const from = task.status;
  const allowed = TASK_EDGES[from] || new Set();
  if (!allowed.has(status)) {
    throw new CliError(`illegal task transition: ${from} -> ${status}`, EXIT_INVALID);
  }
  task.status = status;
  task.updatedAt = ts;
  applyCurrentTask(ticket, taskId, status);
  ticket.updatedAt = ts;
  return { ticket: ticketId, task: taskId, status, from, currentTask: ticket.currentTask };
}

function cmdTicketDepend(state, values, ts) {
  const ticketId = requireOpt(values, "ticket");
  const ticket = ticketOf(state, ticketId);
  const deps = listOpt(values, "depends-on");
  if (deps.length === 0) {
    throw new CliError("--depends-on is required", EXIT_ARGS);
  }
  for (const dep of deps) {
    if (dep === ticketId) {
      throw new CliError("a ticket cannot depend on itself", EXIT_INVALID);
    }
    if (!state.tickets[dep]) {
      throw new CliError(`dependency ticket not found: ${dep}`, EXIT_NOT_FOUND);
    }
    if (!ticket.dependsOn.includes(dep)) {
      ticket.dependsOn.push(dep);
    }
  }
  ticket.updatedAt = ts;
  return { ticket: ticketId, dependsOn: ticket.dependsOn };
}

function cmdReviewRecord(state, values, ts) {
  const ticketId = requireOpt(values, "ticket");
  const taskId = requireOpt(values, "task");
  const ticket = ticketOf(state, ticketId);
  const task = ticket.tasks[taskId];
  if (!task) {
    throw new CliError(`task not found: ${ticketId} ${taskId}`, EXIT_NOT_FOUND);
  }
  task.review = {
    round: requireInt(values, "round"),
    verdict: requireEnum("verdict", requireOpt(values, "verdict"), VERDICTS),
    findingCount: requireInt(values, "finding-count"),
    blockingCount: requireInt(values, "blocking-count"),
    updatedAt: ts,
  };
  task.updatedAt = ts;
  ticket.updatedAt = ts;
  return {
    ticket: ticketId,
    task: taskId,
    round: task.review.round,
    verdict: task.review.verdict,
  };
}

function cmdSessionRecord(state, values, ts) {
  const ticketId = requireOpt(values, "ticket");
  const sessionId = requireOpt(values, "session-id");
  const ticket = ticketOf(state, ticketId);
  const existing = ticket.sessions[sessionId] && typeof ticket.sessions[sessionId] === "object"
    ? ticket.sessions[sessionId]
    : {};
  const status = requireEnum("status", requireOpt(values, "status"), SESSION_STATUSES);
  const subagentId = values["subagent-id"] ?? null;
  if (status === "starting" || status === "running") {
    for (const [id, session] of Object.entries(ticket.sessions)) {
      if (id === sessionId || !session || typeof session !== "object") {
        continue;
      }
      if (session.status !== "starting" && session.status !== "running") {
        continue;
      }
      const sameFile = values.session && session.sessionFile === values.session;
      if (sameFile && session.subagentId && subagentId && session.subagentId !== subagentId) {
        throw new CliError(`active runtime already exists for ${values.session}`, EXIT_INVALID);
      }
    }
    const same = existing;
    if (
      same.subagentId &&
      subagentId &&
      same.subagentId !== subagentId &&
      (same.status === "starting" || same.status === "running")
    ) {
      throw new CliError(`active runtime already exists for session ${sessionId}`, EXIT_INVALID);
    }
  }
  const round = optionalInt(values, "round");
  ticket.sessions[sessionId] = {
    stage: requireEnum("stage", requireOpt(values, "stage"), STAGES),
    task: values.task ?? existing.task ?? null,
    round: round ?? existing.round ?? null,
    model: existing.model ?? null,
    paneId: values.pane ?? existing.paneId ?? null,
    paneName: values["pane-name"] ?? existing.paneName ?? null,
    sessionFile: requireOpt(values, "session"),
    status,
    context: existing.context ?? null,
    startedAt: existing.startedAt ?? ts,
    updatedAt: ts,
    subagentId: subagentId ?? existing.subagentId ?? null,
  };
  ticket.updatedAt = ts;
  return { ticket: ticketId, session: sessionId, status: ticket.sessions[sessionId].status };
}

function cmdMessage(state, values, ts) {
  const ticketId = requireOpt(values, "ticket");
  const ticket = ticketOf(state, ticketId);
  ticket.message = requireOpt(values, "text");
  ticket.messageAt = ts;
  ticket.updatedAt = ts;
  return { ticket: ticketId, message: ticket.message };
}

function cmdBlock(state, values, ts) {
  const ticketId = requireOpt(values, "ticket");
  const ticket = ticketOf(state, ticketId);
  const owner = values.owner ?? "agent";
  requireEnum("owner", owner, OWNERS);
  ticket.blocker = {
    reason: requireOpt(values, "reason"),
    since: ts,
    owner,
    ...(values.task ? { task: values.task } : {}),
  };
  ticket.status = "blocked";
  ticket.updatedAt = ts;
  return { ticket: ticketId, status: ticket.status, blocker: ticket.blocker };
}

function cmdUnblock(state, values, ts) {
  const ticketId = requireOpt(values, "ticket");
  const ticket = ticketOf(state, ticketId);
  ticket.blocker = null;
  if (ticket.status === "blocked") {
    ticket.status = "active";
  }
  ticket.updatedAt = ts;
  return { ticket: ticketId, status: ticket.status, blocker: null };
}

function cmdUsageRecord(state, values, ts) {
  const ticketId = requireOpt(values, "ticket");
  const ticket = ticketOf(state, ticketId);
  const sessionFile = requireOpt(values, "session");
  const stage = requireEnum("stage", requireOpt(values, "stage"), STAGES);
  const parsed = readUsageFromSession(sessionFile);
  const sessionId = parsed.sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new CliError("usage record missing sessionId", EXIT_INVALID);
  }
  const round = optionalInt(values, "round");
  ticket.usage[sessionId] = {
    stage,
    task: values.task ?? null,
    round,
    model: parsed.model ?? null,
    throughEntryId: parsed.throughEntryId ?? null,
    tokens: parsed.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: parsed.costUsd ?? 0,
    recordedAt: ts,
  };
  ticket.updatedAt = ts;
  return { ticket: ticketId, session: sessionId, stage, costUsd: ticket.usage[sessionId].costUsd };
}

function factoryJsonPath(factoryRoot) {
  return path.join(factoryRoot, "FACTORY.json");
}

function readFactoryJson(factoryRoot) {
  const file = factoryJsonPath(factoryRoot);
  if (!existsSync(file)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new CliError(`cannot read FACTORY.json: ${err.message}`, EXIT_INVALID);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("FACTORY.json must be an object", EXIT_INVALID);
  }
  return parsed;
}

function asRole(value) {
  if (typeof value === "string" && value) {
    return { model: value, thinking: "medium" };
  }
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.model === "string" && value.model) {
    return { model: value.model, thinking: value.thinking || "medium" };
  }
  return null;
}

function resolveRole(role, values, existingModels) {
  const modelFlag = values[`${role}-model`];
  const thinkingFlag = values[`${role}-thinking`];
  const previous = asRole(existingModels?.[role]);
  if ((modelFlag === undefined || modelFlag === "") && (thinkingFlag === undefined || thinkingFlag === "")) {
    return previous;
  }
  const model = modelFlag || previous?.model;
  if (!model) {
    throw new CliError(`--${role}-model is required`, EXIT_ARGS);
  }
  const thinking =
    thinkingFlag === undefined || thinkingFlag === ""
      ? "medium"
      : requireEnum(`${role}-thinking`, thinkingFlag, THINKING_LEVELS);
  return { model, thinking };
}

function parseBoolFlag(values, name) {
  const value = values[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new CliError(`--${name} must be true or false`, EXIT_ARGS);
}

function parseLabelFlags(values) {
  const raw = values.label;
  if (raw === undefined) {
    return new Map();
  }
  const list = Array.isArray(raw) ? raw : [raw];
  const parsed = new Map();
  for (const entry of list) {
    const eq = entry.indexOf("=");
    if (eq <= 0 || eq === entry.length - 1) {
      throw new CliError("--label must be <role>=<string>", EXIT_ARGS);
    }
    const role = entry.slice(0, eq);
    const label = entry.slice(eq + 1);
    if (!TRIAGE_ROLES.includes(role)) {
      throw new CliError(`--label role must be one of ${TRIAGE_ROLES.join(", ")}`, EXIT_ARGS);
    }
    parsed.set(role, label);
  }
  return parsed;
}

function storedLabels(existing) {
  const labels = existing?.github?.labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    return null;
  }
  const hasAny = TRIAGE_ROLES.some((role) => typeof labels[role] === "string" && labels[role]);
  return hasAny ? labels : null;
}

function resolveLabels(existing, passed, githubRepoPassed) {
  const stored = storedLabels(existing);
  if (passed.size === 0 && !stored && !githubRepoPassed) {
    return undefined;
  }
  const out = {};
  for (const role of TRIAGE_ROLES) {
    if (passed.has(role)) {
      out[role] = passed.get(role);
    } else if (stored && typeof stored[role] === "string" && stored[role]) {
      out[role] = stored[role];
    } else {
      out[role] = role;
    }
  }
  return out;
}

function buildFactoryJson(existing, values) {
  const existingModels = existing?.models && typeof existing.models === "object" ? existing.models : {};
  const models = {};
  for (const role of MODEL_ROLES) {
    const resolved = resolveRole(role, values, existingModels);
    if (!resolved) {
      throw new CliError(`--${role}-model is required`, EXIT_ARGS);
    }
    models[role] = resolved;
  }
  if (values["arbiter-model"] || values["arbiter-thinking"]) {
    models.arbiter = resolveRole("arbiter", values, existingModels);
  } else if (Object.prototype.hasOwnProperty.call(existingModels, "arbiter")) {
    models.arbiter = existingModels.arbiter === null ? null : asRole(existingModels.arbiter);
  } else {
    models.arbiter = null;
  }
  if (models.review.model === models.work.model) {
    throw new CliError("models.review.model must differ from models.work.model", EXIT_INVALID);
  }

  const patternFlag = values["ticket-id-pattern"];
  const ticketIdPattern =
    patternFlag === undefined || patternFlag === ""
      ? (typeof existing?.ticketIdPattern === "string" && existing.ticketIdPattern) || DEFAULT_TICKET_PATTERN
      : patternFlag;

  const limits =
    existing?.limits && typeof existing.limits === "object" && !Array.isArray(existing.limits)
      ? existing.limits
      : { ...DEFAULT_LIMITS };

  const repoFlag = values["github-repo"];
  const githubRepo = repoFlag || existing?.github?.repo || "";
  const pullFlag = parseBoolFlag(values, "pull-requests");
  const pullRequests =
    pullFlag !== undefined
      ? pullFlag
      : typeof existing?.github?.pullRequests === "boolean"
        ? existing.github.pullRequests
        : false;
  const labels = resolveLabels(existing, parseLabelFlags(values), Boolean(repoFlag));
  const github = {};
  if (githubRepo) {
    github.repo = githubRepo;
  }
  github.pullRequests = pullRequests;
  if (labels) {
    github.labels = labels;
  }
  const cliFlag = parseBoolFlag(values, "github-cli");
  github.cli =
    cliFlag !== undefined ? cliFlag : typeof existing?.github?.cli === "boolean" ? existing.github.cli : false;

  const hookScript = path.join(import.meta.dirname, "hooks", "require-evidence.mjs");
  const defaultHooks = {
    before: [
      { on: "task:ready_for_review", command: `node ${JSON.stringify(hookScript)}` },
      { on: "ticket:wrapup", command: `node ${JSON.stringify(hookScript)}` },
    ],
    after: [],
  };
  const hooks =
    existing?.hooks && typeof existing.hooks === "object" && !Array.isArray(existing.hooks)
      ? existing.hooks
      : defaultHooks;
  const verification =
    existing?.verification && typeof existing.verification === "object" && !Array.isArray(existing.verification)
      ? existing.verification
      : { command: null };

  const preserved = {};
  if (existing) {
    for (const [key, value] of Object.entries(existing)) {
      if (!FACTORY_JSON_KEYS.has(key)) {
        preserved[key] = value;
      }
    }
  }
  return {
    schemaVersion: 2,
    ticketIdPattern,
    models,
    limits,
    github,
    hooks,
    verification,
    ...preserved,
  };
}

const GITHUB_MD = readFileSync(new URL("./github.md", import.meta.url), "utf8");
const EXCLUDE_LINE = "/.factory/";

function renderGithubMd(repo) {
  return GITHUB_MD.replaceAll("<owner/name>", repo);
}

function ensureTicketsDir(factoryRoot) {
  mkdirSync(path.join(factoryRoot, "tickets"), { recursive: true });
}

function ensureGitExclude(factoryRoot) {
  const result = spawnSync("git", ["-C", factoryRoot, "rev-parse", "--git-path", "info/exclude"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return;
  }
  const raw = result.stdout.trim();
  if (!raw) {
    return;
  }
  const excludeFile = path.isAbsolute(raw) ? raw : path.resolve(factoryRoot, raw);
  mkdirSync(path.dirname(excludeFile), { recursive: true });
  const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
  const present = current.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === EXCLUDE_LINE || trimmed === ".factory/" || trimmed === "/.factory" || trimmed === ".factory";
  });
  if (present) {
    return;
  }
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  writeFileSync(excludeFile, `${current}${prefix}${EXCLUDE_LINE}\n`);
}

function writeGithubMd(factoryRoot, repo) {
  if (!repo) {
    return;
  }
  writeFileSync(path.join(factoryRoot, "github.md"), renderGithubMd(repo));
}

function ensureStore(factoryRoot) {
  const db = openStore(factoryRoot, { create: true });
  if (!db) {
    throw new CliError("factory state not found", EXIT_NOT_FOUND);
  }
  db.close();
  return loadState(factoryRoot);
}

const ROLE_AGENT_FILES = ["factory-plan.md", "factory-work.md", "factory-review.md", "factory-wrapup.md"];

function piAgentsDir() {
  return path.join(process.env.HOME || homedir(), ".pi", "agent", "agents");
}

function installRoleAgents() {
  const destDir = piAgentsDir();
  mkdirSync(destDir, { recursive: true });
  const copied = [];
  const skipped = [];
  for (const filename of ROLE_AGENT_FILES) {
    const dest = path.join(destDir, filename);
    if (existsSync(dest)) {
      skipped.push(filename);
      continue;
    }
    const source = fileURLToPath(new URL(`../../agents/${filename}`, import.meta.url));
    if (!existsSync(source)) {
      throw new CliError(`missing role agent ${filename}`, EXIT_IO);
    }
    copyFileSync(source, dest);
    copied.push(filename);
  }
  return { dir: destDir, copied, skipped };
}

function cmdInit(factoryRoot, values) {
  const existing = readFactoryJson(factoryRoot);
  const factoryJson = buildFactoryJson(existing, values);
  ensureTicketsDir(factoryRoot);
  writeFileSync(factoryJsonPath(factoryRoot), `${JSON.stringify(factoryJson, null, 2)}\n`);
  writeGithubMd(factoryRoot, factoryJson.github.repo);
  ensureGitExclude(factoryRoot);
  const state = ensureStore(factoryRoot);
  return {
    ok: true,
    factoryJson,
    revision: state.revision,
    schemaVersion: state.schemaVersion,
    ticketIdPattern: factoryJson.ticketIdPattern,
    pullRequests: factoryJson.github.pullRequests,
    tickets: Object.keys(state.tickets),
    agents: installRoleAgents(),
  };
}

function codeRootSafe() {
  try {
    return codeRoot();
  } catch {
    return null;
  }
}

function readFactoryConfig(factoryRoot) {
  const file = factoryJsonPath(factoryRoot);
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function hookList(config, phase, event) {
  const list = config?.hooks?.[phase];
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((hook) => hook && hook.on === event && typeof hook.command === "string" && hook.command);
}

function runHookList(hooks, envelope, { phase, block }) {
  const runs = [];
  for (const hook of hooks) {
    const started = Date.now();
    const result = spawnSync(hook.command, {
      input: `${JSON.stringify(envelope)}\n`,
      encoding: "utf8",
      timeout: Number(hook.timeoutMs) || 120000,
      shell: true,
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.slice(0, 8000);
    const exitCode = typeof result.status === "number" ? result.status : 1;
    runs.push({
      phase,
      event: envelope.event,
      command: hook.command,
      exitCode,
      durationMs: Date.now() - started,
      output,
      at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    if (block && exitCode !== 0) {
      throw new CliError(`lifecycle hook failed (${envelope.event}): ${hook.command}\n${output}`, EXIT_INVALID);
    }
  }
  return runs;
}

function taskSummaries(ticket) {
  return Object.entries(ticket.tasks || {}).map(([id, task]) => ({
    id,
    status: task?.status ?? null,
    evidencePath: task?.evidencePath ?? null,
  }));
}

function lifecycleEnvelope(state, factoryRoot, command, values) {
  const ticketId = requireOpt(values, "ticket");
  const ticket = ticketOf(state, ticketId);
  if (command === "task transition") {
    const taskId = requireOpt(values, "task");
    const to = requireOpt(values, "status");
    return {
      entity: "task",
      event: `task:${to}`,
      from: ticket.tasks[taskId]?.status ?? null,
      to,
      ticket: ticketId,
      task: taskId,
      codeRoot: codeRootSafe(),
      factoryRoot,
      worktree: ticket.worktree?.path ?? null,
      source: ticket.source ?? null,
      kind: ticket.kind ?? null,
      tasks: taskSummaries(ticket),
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      revision: state.revision,
    };
  }
  const stage = requireOpt(values, "stage");
  return {
    entity: "ticket",
    event: `ticket:${stage}`,
    from: ticket.stage,
    to: stage,
    ticket: ticketId,
    task: ticket.currentTask ?? null,
    codeRoot: codeRootSafe(),
    factoryRoot,
    worktree: ticket.worktree?.path ?? null,
    source: ticket.source ?? null,
    kind: ticket.kind ?? null,
    tasks: taskSummaries(ticket),
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    revision: state.revision,
  };
}

function worktreePathFor(repo, ticket) {
  if (!/^[\w.-]+$/.test(repo)) {
    throw new CliError("--repo must be a single path segment", EXIT_INVALID);
  }
  if (!/^[\w.-]+$/.test(ticket)) {
    throw new CliError("--ticket must be a single path segment", EXIT_INVALID);
  }
  return path.join(process.env.HOME || homedir(), repo, "worktrees", ticket);
}

function issueNumber(ticket) {
  const ref = ticket.source?.ref || "";
  const match = String(ref).match(/\/issues\/(\d+)(?:$|[^\d])/) || String(ref).match(/^#?(\d+)$/);
  return match ? match[1] : null;
}

function reconcileCommands(ticket) {
  const number = issueNumber(ticket);
  if (!number) {
    throw new CliError("ticket has no GitHub issue source", EXIT_INVALID);
  }
  if (ticket.kind === "umbrella") {
    const related = (ticket.dependsOn || []).join(", ") || "none";
    return [`gh issue comment ${number} --body ${JSON.stringify(`Coordinating related tickets: ${related}.`)}`];
  }
  const inReview = Object.values(ticket.tasks || {}).some((task) => task?.status === "in_review");
  const label = ticket.stage === "done" ? "ready-for-human" : inReview || ticket.stage === "review" ? "in-review" : "in-progress";
  const body = `Stage ${ticket.stage}, status ${ticket.status}, current task ${ticket.currentTask || "none"}.`;
  return [
    `gh issue comment ${number} --body ${JSON.stringify(body)}`,
    `gh issue edit ${number} --add-label ${JSON.stringify(label)}`,
  ];
}

async function dispatch(command, values, io) {
  const factoryRoot = resolveFactoryRoot(values["factory-root"]);
  if (command === "init") {
    printJson(io.stdout, cmdInit(factoryRoot, values));
    return;
  }
  const mutations = new Set([
    "create",
    "transition",
    "task transition",
    "task register",
    "ticket depend",
    "review record",
    "session record",
    "message",
    "block",
    "unblock",
    "usage record",
  ]);

  if (command === "status") {
    const state = loadState(factoryRoot);
    if (values.ticket) {
      const ticket = ticketOf(state, values.ticket);
      printJson(io.stdout, {
        ok: true,
        revision: state.revision,
        ticket: values.ticket,
        stage: ticket.stage,
        status: ticket.status,
        state: ticket,
      });
      return;
    }
    printJson(io.stdout, {
      ok: true,
      revision: state.revision,
      schemaVersion: state.schemaVersion,
      updatedAt: state.updatedAt,
      tickets: state.tickets,
    });
    return;
  }

  if (command === "validate") {
    const state = loadState(factoryRoot);
    const errors = validateState(state);
    if (errors.length > 0) {
      throw new CliError(errors.join("; "), EXIT_INVALID);
    }
    const ids = Object.keys(state.tickets);
    printJson(io.stdout, {
      ok: true,
      revision: state.revision,
      schemaVersion: state.schemaVersion,
      tickets: ids,
    });
    return;
  }

  if (command === "usage show") {
    const state = loadState(factoryRoot);
    if (values.stage) {
      requireEnum("stage", values.stage, STAGES);
    }
    const summary = summarizeUsage(state.tickets, {
      ticketId: values.ticket || null,
      stage: values.stage || null,
    });
    printJson(io.stdout, {
      ok: true,
      revision: state.revision,
      ...(values.ticket ? { ticket: values.ticket } : {}),
      ...(values.stage ? { stage: values.stage } : {}),
      ...summary,
    });
    return;
  }

  if (command === "server") {
    const host = values.host || "127.0.0.1";
    const portRaw = values.port;
    const port = portRaw === undefined || portRaw === "" ? 8787 : Number(portRaw);
    if (!Number.isInteger(port) || port < 0) {
      throw new CliError("--port must be a non-negative integer", EXIT_ARGS);
    }
    const started = await startServer({ factoryRoot, host, port });
    printJson(io.stdout, {
      ok: true,
      host: started.host,
      port: started.port,
      url: started.url,
    });
    await new Promise((resolve, reject) => {
      const shutdown = () => {
        started.close().then(resolve, reject);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    return;
  }

  if (command === "worktree path") {
    const target = worktreePathFor(requireOpt(values, "repo"), requireOpt(values, "ticket"));
    printJson(io.stdout, { ok: true, path: target, repo: values.repo, ticket: values.ticket });
    return;
  }

  if (command === "github reconcile") {
    const config = readFactoryConfig(factoryRoot);
    if (!config?.github?.cli) {
      throw new CliError("GitHub CLI is not the ticket source; use .factory/tickets", EXIT_INVALID);
    }
    const state = loadState(factoryRoot);
    const ticket = ticketOf(state, requireOpt(values, "ticket"));
    printJson(io.stdout, {
      ok: true,
      ticket: values.ticket,
      commands: reconcileCommands(ticket),
    });
    return;
  }

  if (!mutations.has(command)) {
    throw new CliError(`unknown command: ${command || "(none)"}\n${USAGE}`, EXIT_ARGS);
  }

  const expectedRevision = requireInt(values, "expected-revision");
  const handlers = {
    create: cmdCreate,
    transition: cmdTransition,
    "task transition": cmdTaskTransition,
    "task register": cmdTaskRegister,
    "ticket depend": cmdTicketDepend,
    "review record": cmdReviewRecord,
    "session record": cmdSessionRecord,
    message: cmdMessage,
    block: cmdBlock,
    unblock: cmdUnblock,
    "usage record": cmdUsageRecord,
  };
  let beforeRuns = [];
  if (command === "transition" || command === "task transition") {
    const current = loadState(factoryRoot);
    const envelope = lifecycleEnvelope(current, factoryRoot, command, values);
    const config = readFactoryConfig(factoryRoot);
    beforeRuns = runHookList(hookList(config, "before", envelope.event), envelope, {
      phase: "before",
      block: true,
    });
  }
  const result = mutate(factoryRoot, expectedRevision, OP_NAMES[command], (state, ts) => {
    const extra = handlers[command](state, values, ts) || {};
    if (beforeRuns.length > 0) {
      extra.hookRuns = beforeRuns;
    }
    return extra;
  });
  if (command === "transition" || command === "task transition") {
    const config = readFactoryConfig(factoryRoot);
    const afterEnvelope = lifecycleEnvelope(loadState(factoryRoot), factoryRoot, command, values);
    afterEnvelope.revision = result.revision;
    const afterRuns = runHookList(hookList(config, "after", afterEnvelope.event), afterEnvelope, {
      phase: "after",
      block: false,
    });
    if (afterRuns.length > 0) {
      mutate(factoryRoot, result.revision, "hook_record", () => ({
        ticket: result.ticket,
        task: result.task ?? null,
        hookRuns: afterRuns,
      }));
    }
  }
  printJson(io.stdout, result);
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: OPTION_SPEC,
      allowPositionals: true,
      strict: true,
    }));
  } catch (err) {
    writeLine(io.stderr, err.message);
    return EXIT_ARGS;
  }
  const command = positionals.join(" ").trim();
  try {
    if (values.help || command === "help" || command.startsWith("help ")) {
      printJson(io.stdout, helpPayload(helpTopic(command, values.help)));
      return EXIT_OK;
    }
    if (!command) {
      writeLine(io.stderr, USAGE);
      return EXIT_ARGS;
    }
    await dispatch(command, values, io);
    return EXIT_OK;
  } catch (err) {
    if (err instanceof CliError) {
      writeLine(io.stderr, err.message);
      return err.code;
    }
    writeLine(io.stderr, err.message || String(err));
    return EXIT_IO;
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.exit(await main(process.argv.slice(2)));
}
