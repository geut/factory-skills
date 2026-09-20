#!/usr/bin/env node
/**
 * Factory-state CLI. Mutate .factory/db/state.sqlite with a revision check
 * and a single SQLite transaction. Do not edit the database by hand.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CliError, EXIT_ARGS, EXIT_INVALID, EXIT_IO, EXIT_NOT_FOUND, EXIT_OK } from "./errors.mjs";
import { startServer } from "./server.mjs";
import { loadState, mutate } from "./store.mjs";

export { EXIT_ARGS, EXIT_INVALID, EXIT_IO, EXIT_NOT_FOUND, EXIT_OK, CliError };

const STAGES = new Set(["plan", "work", "review", "wrapup", "done"]);
const TICKET_STATUSES = new Set(["active", "waiting_for_user", "blocked", "failed", "complete"]);
const TASK_STATUSES = new Set(["pending", "in_progress", "ready_for_review", "done", "blocked"]);
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
    summary: "Set a task status and currentTask.",
    required: ["--ticket", "--task", "--status", "--expected-revision"],
    optional: [],
    flagEnums: { "--status": "taskStatus" },
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
    optional: ["--task", "--round", "--pane", "--pane-name"],
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
    tasks: {},
    sessions: {},
    usage: {},
  };
}

function emptyTask(ts) {
  return {
    status: "pending",
    blockedBy: [],
    review: emptyReview(),
    updatedAt: ts,
  };
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
  if (state.schemaVersion !== 3) {
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
  const ticket = emptyTicket(values, ts);
  state.tickets[ticketId] = ticket;
  return { ticket: ticketId, stage: ticket.stage, status: ticket.status };
}

function cmdTransition(state, values, ts) {
  const ticketId = requireOpt(values, "ticket");
  const ticket = ticketOf(state, ticketId);
  ticket.stage = requireEnum("stage", requireOpt(values, "stage"), STAGES);
  ticket.status = requireEnum("status", requireOpt(values, "status"), TICKET_STATUSES);
  ticket.updatedAt = ts;
  return { ticket: ticketId, stage: ticket.stage, status: ticket.status };
}

function cmdTaskTransition(state, values, ts) {
  const ticketId = requireOpt(values, "ticket");
  const taskId = requireOpt(values, "task");
  const ticket = ticketOf(state, ticketId);
  const status = requireEnum("status", requireOpt(values, "status"), TASK_STATUSES);
  const task = ticket.tasks[taskId] ?? emptyTask(ts);
  task.status = status;
  task.updatedAt = ts;
  ticket.tasks[taskId] = task;
  ticket.currentTask = taskId;
  ticket.updatedAt = ts;
  return { ticket: ticketId, task: taskId, status };
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
  const round = optionalInt(values, "round");
  ticket.sessions[sessionId] = {
    stage: requireEnum("stage", requireOpt(values, "stage"), STAGES),
    task: values.task ?? existing.task ?? null,
    round: round ?? existing.round ?? null,
    model: existing.model ?? null,
    paneId: values.pane ?? existing.paneId ?? null,
    paneName: values["pane-name"] ?? existing.paneName ?? null,
    sessionFile: requireOpt(values, "session"),
    status: requireEnum("status", requireOpt(values, "status"), SESSION_STATUSES),
    context: existing.context ?? null,
    startedAt: existing.startedAt ?? ts,
    updatedAt: ts,
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

async function dispatch(command, values, io) {
  const factoryRoot = resolveFactoryRoot(values["factory-root"]);
  const mutations = new Set([
    "create",
    "transition",
    "task transition",
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

  if (!mutations.has(command)) {
    throw new CliError(`unknown command: ${command || "(none)"}\n${USAGE}`, EXIT_ARGS);
  }

  const expectedRevision = requireInt(values, "expected-revision");
  const handlers = {
    create: cmdCreate,
    transition: cmdTransition,
    "task transition": cmdTaskTransition,
    "review record": cmdReviewRecord,
    "session record": cmdSessionRecord,
    message: cmdMessage,
    block: cmdBlock,
    unblock: cmdUnblock,
    "usage record": cmdUsageRecord,
  };
  const result = mutate(factoryRoot, expectedRevision, OP_NAMES[command], (state, ts) =>
    handlers[command](state, values, ts),
  );
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
