import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, test } from "node:test";
import {
  EXIT_ARGS,
  EXIT_INVALID,
  EXIT_NOT_FOUND,
  EXIT_OK,
  main,
} from "./cli.mjs";
import { startServer } from "./server.mjs";
import { stateDbPath } from "./store.mjs";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "recap-after-contract.jsonl");
const ROLE_AGENTS = ["factory-plan.md", "factory-work.md", "factory-review.md", "factory-wrapup.md"];
const suiteHome = mkdtempSync(path.join(tmpdir(), "fstate-home-"));
process.env.HOME = suiteHome;
const roots = [];
const servers = [];

after(async () => {
  await rm(suiteHome, { recursive: true, force: true });
});

async function tempRoot(parent = tmpdir()) {
  const dir = await mkdtemp(path.join(parent, "fstate-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length) {
    const close = servers.pop();
    await close().catch(() => {});
  }
  while (roots.length) {
    const dir = roots.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

async function run(args) {
  let out = "";
  let err = "";
  const code = await main(args, {
    stdout: { write(chunk) { out += chunk; return true; } },
    stderr: { write(chunk) { err += chunk; return true; } },
  });
  let json = null;
  if (out.trim()) {
    try {
      json = JSON.parse(out);
    } catch {
      json = null;
    }
  }
  return { code, out, err, json };
}

function fstate(root, ...args) {
  return run(["--factory-root", root, ...args]);
}

async function readState(root) {
  const status = await fstate(root, "status");
  assert.equal(status.code, EXIT_OK, status.err);
  return status.json;
}

function readEvents(root) {
  const db = new DatabaseSync(stateDbPath(root), { readOnly: true });
  try {
    return db.prepare("SELECT revision, op, ticket_id, task_id FROM events ORDER BY revision").all();
  } finally {
    db.close();
  }
}

const INIT_MODELS = [
  "--plan-model",
  "provider/plan",
  "--work-model",
  "provider/work",
  "--review-model",
  "provider/review",
  "--wrapup-model",
  "provider/wrapup",
];

async function readFactoryJson(root) {
  return JSON.parse(await readFile(path.join(root, "FACTORY.json"), "utf8"));
}

test("init writes FACTORY.json and an empty store", async () => {
  const root = await tempRoot();
  const result = await fstate(root, "init", ...INIT_MODELS, "--plan-thinking", "high");
  assert.equal(result.code, EXIT_OK, result.err);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.revision, 0);
  assert.equal(result.json.schemaVersion, 4);
  assert.equal(result.json.ticketIdPattern, "PROJ-<number>");
  assert.equal(result.json.pullRequests, false);
  assert.deepEqual(result.json.tickets, []);
  assert.equal(result.json.factoryJson.schemaVersion, 2);
  assert.equal(result.json.factoryJson.models.plan.thinking, "high");
  assert.equal(result.json.factoryJson.models.work.thinking, "medium");
  assert.equal(result.json.factoryJson.models.arbiter, null);
  assert.equal(existsSync(stateDbPath(root)), true);
  assert.equal(existsSync(path.join(root, "tickets")), true);
  assert.equal(existsSync(path.join(root, "github.md")), false);
  assert.equal(result.json.agents.dir, path.join(suiteHome, ".pi", "agent", "agents"));
  assert.deepEqual([...result.json.agents.copied, ...result.json.agents.skipped].sort(), [...ROLE_AGENTS].sort());
  assert.deepEqual(readEvents(root), []);

  const file = await readFactoryJson(root);
  assert.equal(file.ticketIdPattern, "PROJ-<number>");
  assert.equal(file.github.pullRequests, false);
  assert.equal(file.github.repo, undefined);
  assert.equal(file.github.labels, undefined);
  assert.deepEqual(file.limits, { maxTickets: 2, maxAgents: 4, reviewRounds: 3 });

  const status = await fstate(root, "status");
  assert.equal(status.code, EXIT_OK, status.err);
  assert.equal(status.json.revision, 0);
  assert.deepEqual(status.json.tickets, {});
});

test("init defaults, overrides, and a second run keep stored config", async () => {
  const root = await tempRoot();
  const first = await fstate(
    root,
    "init",
    ...INIT_MODELS,
    "--ticket-id-pattern",
    "SHOP-<number>",
    "--pull-requests",
    "true",
    "--github-repo",
    "acme/shop",
    "--label",
    "needs-triage=bug:triage",
  );
  assert.equal(first.code, EXIT_OK, first.err);
  assert.equal(first.json.ticketIdPattern, "SHOP-<number>");
  assert.equal(first.json.pullRequests, true);
  assert.equal(first.json.factoryJson.github.repo, "acme/shop");
  assert.equal(first.json.factoryJson.github.labels["needs-triage"], "bug:triage");
  assert.equal(first.json.factoryJson.github.labels["needs-info"], "needs-info");
  assert.equal(first.json.factoryJson.github.labels["ready-for-agent"], "ready-for-agent");
  assert.equal(first.json.factoryJson.github.labels["wontfix"], "wontfix");

  const filePath = path.join(root, "FACTORY.json");
  const withExtra = await readFactoryJson(root);
  withExtra.budgets = { plan: 1 };
  await writeFile(filePath, `${JSON.stringify(withExtra, null, 2)}\n`);

  const second = await fstate(root, "init");
  assert.equal(second.code, EXIT_OK, second.err);
  assert.equal(second.json.revision, 0);
  assert.equal(second.json.ticketIdPattern, "SHOP-<number>");
  assert.equal(second.json.pullRequests, true);
  assert.equal(second.json.factoryJson.models.work.model, "provider/work");
  assert.equal(second.json.factoryJson.github.labels["needs-triage"], "bug:triage");
  assert.deepEqual(second.json.factoryJson.budgets, { plan: 1 });
  assert.deepEqual(second.json.tickets, []);
});

test("init with a github repo and no labels stores the five defaults", async () => {
  const root = await tempRoot();
  const result = await fstate(root, "init", ...INIT_MODELS, "--github-repo", "acme/shop");
  assert.equal(result.code, EXIT_OK, result.err);
  assert.deepEqual(result.json.factoryJson.github.labels, {
    "needs-triage": "needs-triage",
    "needs-info": "needs-info",
    "ready-for-agent": "ready-for-agent",
    "ready-for-human": "ready-for-human",
    wontfix: "wontfix",
  });
  const github = await readFile(path.join(root, "github.md"), "utf8");
  assert.match(github, /acme\/shop/);
  assert.doesNotMatch(github, /<owner\/name>/);
});

test("init excludes .factory once when the factory root is inside a Git repo", async () => {
  const repo = await tempRoot(import.meta.dirname);
  const template = path.join(repo, "git-template");
  await mkdir(template);
  execFileSync("git", ["init", "--template", template], { cwd: repo });
  const factory = path.join(repo, ".factory");
  const first = await fstate(factory, "init", ...INIT_MODELS);
  assert.equal(first.code, EXIT_OK, first.err);
  const excludePath = path.join(repo, ".git", "info", "exclude");
  const exclude = await readFile(excludePath, "utf8");
  assert.match(exclude, /^\/\.factory\/$/m);
  const second = await fstate(factory, "init");
  assert.equal(second.code, EXIT_OK, second.err);
  const again = await readFile(excludePath, "utf8");
  assert.deepEqual(again.match(/^\/\.factory\/$/gm), ["/.factory/"]);
});

test("init rejects a bad label role and a review model equal to work", async () => {
  const root = await tempRoot();
  const badLabel = await fstate(root, "init", ...INIT_MODELS, "--label", "bug=bug");
  assert.equal(badLabel.code, EXIT_ARGS);
  assert.match(badLabel.err, /--label role must be one of/);
  assert.equal(existsSync(path.join(root, "FACTORY.json")), false);

  const sameModel = await fstate(
    root,
    "init",
    "--plan-model",
    "provider/plan",
    "--work-model",
    "provider/same",
    "--review-model",
    "provider/same",
    "--wrapup-model",
    "provider/wrapup",
  );
  assert.equal(sameModel.code, EXIT_INVALID);
  assert.match(sameModel.err, /models\.review\.model must differ/);
  assert.equal(existsSync(stateDbPath(root)), false);
});

test("init copies missing role agents and does not overwrite an existing file", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "fstate-agents-"));
  roots.push(home);
  const root = mkdtempSync(path.join(tmpdir(), "fstate-"));
  roots.push(root);
  const cli = path.join(import.meta.dirname, "cli.mjs");
  const agentsDir = path.join(home, ".pi", "agent", "agents");
  const runInit = (args) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, "--factory-root", root, "init", ...args], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }),
    );
  assert.throws(() => runInit(["--plan-model", "provider/plan"]), (err) => err.status === EXIT_ARGS);
  assert.equal(existsSync(agentsDir), false);

  const first = runInit(INIT_MODELS);
  assert.deepEqual(first.agents.copied, ROLE_AGENTS);
  assert.deepEqual(first.agents.skipped, []);
  assert.equal(first.agents.dir, agentsDir);
  const sourceDir = path.join(import.meta.dirname, "..", "..", "agents");
  for (const filename of ROLE_AGENTS) {
    assert.equal(await readFile(path.join(agentsDir, filename), "utf8"), await readFile(path.join(sourceDir, filename), "utf8"));
  }
  const custom = "custom agent\n";
  await writeFile(path.join(agentsDir, "factory-review.md"), custom);
  const second = runInit([]);
  assert.deepEqual(second.agents.copied, []);
  assert.deepEqual(second.agents.skipped, ROLE_AGENTS);
  assert.equal(await readFile(path.join(agentsDir, "factory-review.md"), "utf8"), custom);
});

test("init requires role models until FACTORY.json exists", async () => {
  const root = await tempRoot();
  const missing = await fstate(root, "init", "--plan-model", "provider/plan");
  assert.equal(missing.code, EXIT_ARGS);
  assert.match(missing.err, /--work-model is required/);
});

test("create still starts at revision 0 after init", async () => {
  const root = await tempRoot();
  const init = await fstate(root, "init", ...INIT_MODELS);
  assert.equal(init.code, EXIT_OK, init.err);
  const created = await fstate(root, "create", "--ticket", "PROJ-123", "--expected-revision", "0");
  assert.equal(created.code, EXIT_OK, created.err);
  assert.equal(created.json.revision, 1);
  assert.equal(created.json.ticket, "PROJ-123");
  const again = await fstate(root, "init");
  assert.equal(again.code, EXIT_OK, again.err);
  assert.equal(again.json.revision, 1);
  assert.deepEqual(again.json.tickets, ["PROJ-123"]);
});

test("create then status --ticket", async () => {
  const root = await tempRoot();
  const created = await fstate(
    root,
    "create",
    "--ticket",
    "PROJ-123",
    "--title",
    "Restore the saved catalog filter",
    "--type",
    "feature",
    "--source-kind",
    "github",
    "--source-ref",
    "https://github.example/org/repo/issues/123",
    "--worktree-path",
    "/runtime/worktrees/PROJ-123",
    "--branch",
    "PROJ-123",
    "--base-branch",
    "main",
    "--workspace-id",
    "w2",
    "--expected-revision",
    "0",
  );
  assert.equal(created.code, EXIT_OK, created.err);
  assert.equal(created.json.ok, true);
  assert.equal(created.json.revision, 1);
  assert.equal(created.json.ticket, "PROJ-123");
  assert.equal(created.json.stage, "plan");
  assert.equal(created.json.status, "active");
  assert.equal(existsSync(stateDbPath(root)), true);

  const status = await fstate(root, "status", "--ticket", "PROJ-123");
  assert.equal(status.code, EXIT_OK, status.err);
  assert.equal(status.json.revision, 1);
  assert.equal(status.json.state.title, "Restore the saved catalog filter");
  assert.equal(status.json.state.worktree.branch, "PROJ-123");
  assert.equal(status.json.state.source.kind, "github");
});

test("transition with wrong expected-revision does not change state", async () => {
  const root = await tempRoot();
  await fstate(root, "create", "--ticket", "PROJ-123", "--expected-revision", "0");
  const before = await readState(root);

  const failed = await fstate(
    root,
    "transition",
    "--ticket",
    "PROJ-123",
    "--stage",
    "work",
    "--status",
    "active",
    "--expected-revision",
    "0",
  );
  assert.equal(failed.code, EXIT_INVALID);
  assert.match(failed.err, /revision mismatch/);

  const after = await readState(root);
  assert.equal(after.revision, before.revision);
  assert.equal(after.tickets["PROJ-123"].stage, "plan");
});

test("task, review, session, message, block, and unblock", async () => {
  const root = await tempRoot();
  await fstate(root, "create", "--ticket", "PROJ-123", "--expected-revision", "0");

  const registered = await fstate(
    root,
    "task",
    "register",
    "--ticket",
    "PROJ-123",
    "--task",
    "01",
    "--expected-revision",
    "1",
  );
  assert.equal(registered.code, EXIT_OK, registered.err);
  assert.equal(registered.json.status, "pending");
  assert.equal(registered.json.currentTask, null);

  const task = await fstate(
    root,
    "task",
    "transition",
    "--ticket",
    "PROJ-123",
    "--task",
    "01",
    "--status",
    "in_progress",
    "--expected-revision",
    "2",
  );
  assert.equal(task.code, EXIT_OK, task.err);
  assert.equal(task.json.revision, 3);
  assert.equal(task.json.task, "01");
  assert.equal(task.json.status, "in_progress");

  const review = await fstate(
    root,
    "review",
    "record",
    "--ticket",
    "PROJ-123",
    "--task",
    "01",
    "--round",
    "1",
    "--verdict",
    "approve",
    "--finding-count",
    "0",
    "--blocking-count",
    "0",
    "--expected-revision",
    "3",
  );
  assert.equal(review.code, EXIT_OK, review.err);
  assert.equal(review.json.verdict, "approve");

  const session = await fstate(
    root,
    "session",
    "record",
    "--ticket",
    "PROJ-123",
    "--session-id",
    "sess-1",
    "--session",
    "/tmp/session.jsonl",
    "--stage",
    "review",
    "--status",
    "completed",
    "--task",
    "01",
    "--round",
    "1",
    "--pane",
    "p4",
    "--pane-name",
    "PROJ-123 · review T01 R1",
    "--expected-revision",
    "4",
  );
  assert.equal(session.code, EXIT_OK, session.err);

  const message = await fstate(
    root,
    "message",
    "--ticket",
    "PROJ-123",
    "--text",
    "Review task 01 completed",
    "--expected-revision",
    "5",
  );
  assert.equal(message.code, EXIT_OK, message.err);

  const blocked = await fstate(
    root,
    "block",
    "--ticket",
    "PROJ-123",
    "--reason",
    "need a product decision",
    "--owner",
    "user",
    "--task",
    "01",
    "--expected-revision",
    "6",
  );
  assert.equal(blocked.code, EXIT_OK, blocked.err);
  assert.equal(blocked.json.status, "blocked");
  assert.equal(blocked.json.blocker.owner, "user");
  assert.equal(blocked.json.blocker.task, "01");

  const unblocked = await fstate(
    root,
    "unblock",
    "--ticket",
    "PROJ-123",
    "--expected-revision",
    "7",
  );
  assert.equal(unblocked.code, EXIT_OK, unblocked.err);
  assert.equal(unblocked.json.status, "active");
  assert.equal(unblocked.json.blocker, null);

  const state = await readState(root);
  assert.equal(state.revision, 8);
  assert.equal(state.tickets["PROJ-123"].currentTask, "01");
  assert.equal(state.tickets["PROJ-123"].tasks["01"].review.round, 1);
  assert.equal(state.tickets["PROJ-123"].sessions["sess-1"].paneName, "PROJ-123 · review T01 R1");
  assert.equal(state.tickets["PROJ-123"].message, "Review task 01 completed");
  assert.equal(state.tickets["PROJ-123"].blocker, null);

  const events = readEvents(root);
  assert.equal(events.length, 8);
  assert.deepEqual(events.map((row) => row.op), [
    "create",
    "task_register",
    "task_transition",
    "review_record",
    "session_record",
    "message",
    "block",
    "unblock",
  ]);
});

test("usage record calls pi-session-reader and usage show sums it", async () => {
  const root = await tempRoot();
  await fstate(root, "create", "--ticket", "PROJ-14", "--expected-revision", "0");

  const recorded = await fstate(
    root,
    "usage",
    "record",
    "--ticket",
    "PROJ-14",
    "--stage",
    "plan",
    "--session",
    FIXTURE,
    "--task",
    "01",
    "--expected-revision",
    "1",
  );
  assert.equal(recorded.code, EXIT_OK, recorded.err);
  assert.equal(recorded.json.session, "sess-plan-1");
  assert.equal(recorded.json.stage, "plan");

  const shown = await fstate(root, "usage", "show", "--ticket", "PROJ-14");
  assert.equal(shown.code, EXIT_OK, shown.err);
  assert.equal(shown.json.tickets["PROJ-14"].total.sessions, 1);
  assert.equal(shown.json.tickets["PROJ-14"].stages.plan.sessions, 1);
  assert.deepEqual(shown.json.tickets["PROJ-14"].total.tokens, {
    input: 171,
    output: 1016,
    cacheRead: 53924,
    cacheWrite: 5,
    total: 55116,
  });
  assert.equal(shown.json.total.costUsd, recorded.json.costUsd);

  const state = await readState(root);
  const usage = state.tickets["PROJ-14"].usage["sess-plan-1"];
  assert.equal(usage.model, "opencode-go/glm-5.3");
  assert.equal(usage.throughEntryId, "a3");
  assert.equal(usage.task, "01");
});

test("v2 JSON migrates into sqlite on the next mutation; unknown fields stay null", async () => {
  const root = await tempRoot();
  await writeFile(
    path.join(root, "FACTORY-STATE.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        revision: 4,
        tickets: {
          "PROJ-12": {
            stage: "wrapup",
            status: "active",
            tasks: {
              "01": { status: "done", reviewRound: 1 },
            },
            sessions: {
              "sess-old": { stage: "review", status: "completed", sessionFile: "/tmp/a.jsonl" },
            },
            usage: {},
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const result = await fstate(
    root,
    "message",
    "--ticket",
    "PROJ-12",
    "--text",
    "migrated",
    "--expected-revision",
    "4",
  );
  assert.equal(result.code, EXIT_OK, result.err);
  assert.equal(result.json.revision, 5);
  assert.equal(existsSync(stateDbPath(root)), true);

  const state = await readState(root);
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.updatedAt != null, true);
  const ticket = state.tickets["PROJ-12"];
  assert.equal(ticket.title, null);
  assert.equal(ticket.type, null);
  assert.equal(ticket.source, null);
  assert.equal(ticket.createdAt, null);
  assert.equal(ticket.worktree, null);
  assert.equal(ticket.message, "migrated");
  assert.equal(ticket.tasks["01"].review.round, 1);
  assert.equal(ticket.tasks["01"].review.verdict, null);
  assert.equal(ticket.tasks["01"].review.findingCount, null);
  assert.equal("reviewRound" in ticket.tasks["01"], false);
  assert.equal(ticket.sessions["sess-old"].paneName, null);
  assert.equal(ticket.sessions["sess-old"].context, null);
});

test("status and validate of a missing store exit 3", async () => {
  const root = await tempRoot();
  const status = await fstate(root, "status");
  assert.equal(status.code, EXIT_NOT_FOUND);
  const validated = await fstate(root, "validate");
  assert.equal(validated.code, EXIT_NOT_FOUND);
});

test("help prints a JSON catalog without a factory root", async () => {
  const result = await run(["help"]);
  assert.equal(result.code, EXIT_OK, result.err);
  assert.equal(result.json.ok, true);
  assert.match(result.json.usage, /node cli\.mjs <command>/);
  assert.equal(result.json.global[0].flag, "--factory-root");
  assert.deepEqual(result.json.enums.stage, ["plan", "work", "review", "wrapup", "done"]);
  const names = result.json.commands.map((command) => command.name);
  assert.deepEqual(names, [
    "help",
    "init",
    "create",
    "status",
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
    "usage show",
    "validate",
    "server",
    "worktree path",
    "github reconcile",
    "seed",
  ]);
  const create = result.json.commands.find((command) => command.name === "create");
  assert.equal(create.mutation, true);
  assert.ok(create.required.includes("--expected-revision"));
  const status = result.json.commands.find((command) => command.name === "status");
  assert.equal(status.mutation, false);
});

test("--help and -h match the help command", async () => {
  const long = await run(["--help"]);
  const short = await run(["-h"]);
  const named = await run(["help"]);
  assert.equal(long.code, EXIT_OK, long.err);
  assert.equal(short.code, EXIT_OK, short.err);
  assert.deepEqual(long.json, named.json);
  assert.deepEqual(short.json, named.json);
});

test("help <command> and <command> --help filter the catalog", async () => {
  const byTopic = await run(["help", "create"]);
  assert.equal(byTopic.code, EXIT_OK, byTopic.err);
  assert.deepEqual(
    byTopic.json.commands.map((command) => command.name),
    ["create"],
  );
  const twoWord = await run(["help", "task", "transition"]);
  assert.equal(twoWord.code, EXIT_OK, twoWord.err);
  assert.equal(twoWord.json.commands[0].name, "task transition");
  assert.equal(twoWord.json.commands[0].flagEnums["--status"], "taskStatus");
  const byFlag = await run(["create", "--help"]);
  assert.equal(byFlag.code, EXIT_OK, byFlag.err);
  assert.deepEqual(byFlag.json, byTopic.json);
});

test("seed help writes a temporary root and does not accept a destination", async () => {
  const byFlag = await run(["seed", "--help"]);
  const byShort = await run(["seed", "-h"]);
  const byTopic = await run(["help", "seed"]);
  assert.equal(byFlag.code, EXIT_OK, byFlag.err);
  assert.deepEqual(byShort.json, byFlag.json);
  assert.deepEqual(byTopic.json, byFlag.json);
  assert.deepEqual(byFlag.json.global, []);
  const seed = byFlag.json.commands[0];
  assert.equal(seed.name, "seed");
  assert.equal(seed.mutation, true);
  assert.deepEqual(seed.required, []);
  assert.deepEqual(seed.optional, []);
  assert.match(seed.note, /temporary factory root/);
  assert.match(seed.note, /Does not accept --factory-root/);
  assert.match(seed.note, /FACTORY_ROOT/);
  assert.match(seed.note, /<git-toplevel>\/\.factory/);
});

test("seed ignores FACTORY_ROOT and rejects --factory-root", async () => {
  const absent = path.join(tmpdir(), `fstate-seed-absent-${process.pid}`);
  const previous = process.env.FACTORY_ROOT;
  process.env.FACTORY_ROOT = absent;
  try {
    const result = await run(["seed"]);
    assert.equal(result.code, EXIT_OK, result.err);
    roots.push(result.json.factoryRoot);
    assert.equal(existsSync(absent), false);
    assert.notEqual(result.json.factoryRoot, absent);
    assert.equal(result.json.path, stateDbPath(result.json.factoryRoot));
    assert.equal(existsSync(result.json.path), true);
  } finally {
    if (previous === undefined) {
      delete process.env.FACTORY_ROOT;
    } else {
      process.env.FACTORY_ROOT = previous;
    }
  }

  const live = await tempRoot();
  const marker = path.join(live, "keep");
  await writeFile(marker, "live");
  const rejected = await run(["seed", "--factory-root", live]);
  assert.equal(rejected.code, EXIT_ARGS);
  assert.match(rejected.err, /does not accept --factory-root/);
  assert.equal(await readFile(marker, "utf8"), "live");
  assert.equal(existsSync(stateDbPath(live)), false);

  const replaced = await run(["seed", "--replace"]);
  assert.equal(replaced.code, EXIT_ARGS);
  assert.match(replaced.err, /--replace/);
});

test("seed writes the board into a new temporary root", async () => {
  const seeded = await run(["seed"]);
  assert.equal(seeded.code, EXIT_OK, seeded.err);
  const root = seeded.json.factoryRoot;
  roots.push(root);
  assert.equal(seeded.json.ok, true);
  assert.equal(seeded.json.path, stateDbPath(root));
  const ids = ["PROJ-14", "PROJ-22", "PROJ-29", "PROJ-38", "PROJ-41"];
  assert.deepEqual(seeded.json.tickets, ids);

  const status = await fstate(root, "status");
  assert.equal(status.code, EXIT_OK, status.err);
  assert.deepEqual(Object.keys(status.json.tickets).sort(), ids);
  assert.equal(status.json.revision, seeded.json.revision);

  const db = new DatabaseSync(stateDbPath(root), { readOnly: true });
  const eventCount = Number(db.prepare("SELECT COUNT(*) AS n FROM events").get().n);
  const revision = Number(db.prepare("SELECT value FROM meta WHERE key = 'revision'").get().value);
  db.close();
  assert.equal(revision, eventCount);
  assert.equal(status.json.revision, eventCount);

  const validated = await fstate(root, "validate");
  assert.equal(validated.code, EXIT_OK, validated.err);
  assert.deepEqual([...validated.json.tickets].sort(), ids);

  const board = status.json.tickets;
  assert.equal(board["PROJ-14"].stage, "done");
  assert.equal(board["PROJ-14"].status, "complete");
  assert.equal(board["PROJ-22"].status, "blocked");
  assert.equal(board["PROJ-22"].blocker.owner, "user");
  assert.equal(board["PROJ-29"].tasks["02"].status, "in_review");
  const runningId = Object.keys(board["PROJ-29"].sessions).find(
    (id) => board["PROJ-29"].sessions[id].status === "running",
  );
  assert.ok(runningId);
  assert.equal(board["PROJ-29"].usage[runningId], undefined);
  assert.deepEqual(board["PROJ-38"].dependsOn, ["PROJ-14"]);
  assert.equal(board["PROJ-38"].tasks["01"].status, "ready_for_review");
  assert.equal(board["PROJ-38"].tasks["02"].status, "in_progress");
  assert.equal(board["PROJ-41"].status, "waiting_for_user");

  const again = await run(["seed"]);
  assert.equal(again.code, EXIT_OK, again.err);
  roots.push(again.json.factoryRoot);
  assert.notEqual(again.json.factoryRoot, root);
  assert.equal(again.json.revision, seeded.json.revision);
  assert.deepEqual(again.json.tickets, ids);
});

test("unknown help topic and empty argv exit 2", async () => {
  const unknown = await run(["help", "nope"]);
  assert.equal(unknown.code, EXIT_ARGS);
  assert.match(unknown.err, /unknown command: nope/);
  const empty = await run([]);
  assert.equal(empty.code, EXIT_ARGS);
  assert.match(empty.err, /Usage: node cli\.mjs/);
  assert.match(empty.err, / {2}help\n/);
});

test("unknown command and missing mutation flags exit 2", async () => {
  const root = await tempRoot();
  const unknown = await fstate(root, "nope");
  assert.equal(unknown.code, EXIT_ARGS);
  const missing = await fstate(root, "create", "--expected-revision", "0");
  assert.equal(missing.code, EXIT_ARGS);
  assert.match(missing.err, /--ticket is required/);
});

test("validate accepts a well-formed store", async () => {
  const root = await tempRoot();
  await fstate(root, "create", "--ticket", "PROJ-123", "--expected-revision", "0");
  const result = await fstate(root, "validate");
  assert.equal(result.code, EXIT_OK, result.err);
  assert.deepEqual(result.json.tickets, ["PROJ-123"]);
  assert.equal(result.json.schemaVersion, 4);
});

test("server streams a transition over SSE", async () => {
  const root = await tempRoot();
  await fstate(root, "create", "--ticket", "PROJ-123", "--expected-revision", "0");
  const started = await startServer({ factoryRoot: root, host: "127.0.0.1", port: 0 });
  servers.push(started.close);

  const health = await fetch(`http://127.0.0.1:${started.port}/health`);
  assert.equal(health.status, 200);
  const healthJson = await health.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.revision, 1);
  assert.equal(healthJson.schemaVersion, 4);

  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${started.port}/events?after=1`, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const got = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("sse closed before transition");
      }
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("event: transition")) {
        return buf;
      }
    }
  })();

  const transition = await fstate(
    root,
    "transition",
    "--ticket",
    "PROJ-123",
    "--stage",
    "work",
    "--status",
    "active",
    "--expected-revision",
    "1",
  );
  assert.equal(transition.code, EXIT_OK, transition.err);

  const body = await got;
  ac.abort();
  assert.match(body, /event: transition/);
  assert.match(body, /"ticket":"PROJ-123"/);
  assert.match(body, /"revision":2/);
});

test("task register is idempotent, rejects conflicts, and transitions follow the graph", async () => {
  const root = await tempRoot();
  await fstate(root, "create", "--ticket", "PROJ-123", "--expected-revision", "0");
  const first = await fstate(
    root,
    "task",
    "register",
    "--ticket",
    "PROJ-123",
    "--task",
    "01",
    "--expected-revision",
    "1",
  );
  assert.equal(first.code, EXIT_OK, first.err);
  const again = await fstate(
    root,
    "task",
    "register",
    "--ticket",
    "PROJ-123",
    "--task",
    "01",
    "--expected-revision",
    "2",
  );
  assert.equal(again.code, EXIT_OK, again.err);
  assert.equal(again.json.currentTask, null);

  const conflict = await fstate(
    root,
    "task",
    "register",
    "--ticket",
    "PROJ-123",
    "--task",
    "01",
    "--depends-on",
    "00",
    "--expected-revision",
    "3",
  );
  assert.equal(conflict.code, EXIT_INVALID);
  assert.match(conflict.err, /different state/);

  const missing = await fstate(
    root,
    "task",
    "transition",
    "--ticket",
    "PROJ-123",
    "--task",
    "99",
    "--status",
    "in_progress",
    "--expected-revision",
    "3",
  );
  assert.equal(missing.code, EXIT_NOT_FOUND);
  assert.match(missing.err, /register it first/);

  await fstate(
    root,
    "task",
    "transition",
    "--ticket",
    "PROJ-123",
    "--task",
    "01",
    "--status",
    "in_progress",
    "--expected-revision",
    "3",
  );
  const illegal = await fstate(
    root,
    "task",
    "transition",
    "--ticket",
    "PROJ-123",
    "--task",
    "01",
    "--status",
    "done",
    "--expected-revision",
    "4",
  );
  assert.equal(illegal.code, EXIT_INVALID);
  assert.match(illegal.err, /illegal task transition/);

  await fstate(
    root,
    "task",
    "transition",
    "--ticket",
    "PROJ-123",
    "--task",
    "01",
    "--status",
    "ready_for_review",
    "--expected-revision",
    "4",
  );
  await fstate(
    root,
    "task",
    "transition",
    "--ticket",
    "PROJ-123",
    "--task",
    "01",
    "--status",
    "in_review",
    "--expected-revision",
    "5",
  );
  const done = await fstate(
    root,
    "task",
    "transition",
    "--ticket",
    "PROJ-123",
    "--task",
    "01",
    "--status",
    "done",
    "--expected-revision",
    "6",
  );
  assert.equal(done.code, EXIT_OK, done.err);
  assert.equal(done.json.currentTask, null);
  const state = await readState(root);
  assert.equal(state.tickets["PROJ-123"].tasks["01"].status, "done");
  assert.equal(state.tickets["PROJ-123"].currentTask, null);
});

test("evidence hook blocks ready_for_review and concrete wrapup until manifests exist", async () => {
  const root = await tempRoot();
  await fstate(root, "init", ...INIT_MODELS);
  await fstate(root, "create", "--ticket", "PROJ-9", "--kind", "concrete", "--expected-revision", "0");
  await fstate(root, "task", "register", "--ticket", "PROJ-9", "--task", "01", "--expected-revision", "1");
  await fstate(
    root,
    "task",
    "transition",
    "--ticket",
    "PROJ-9",
    "--task",
    "01",
    "--status",
    "in_progress",
    "--expected-revision",
    "2",
  );
  const blocked = await fstate(
    root,
    "task",
    "transition",
    "--ticket",
    "PROJ-9",
    "--task",
    "01",
    "--status",
    "ready_for_review",
    "--expected-revision",
    "3",
  );
  assert.equal(blocked.code, EXIT_INVALID, blocked.err);
  assert.match(blocked.err, /missing evidence manifest/);
  const unchanged = await readState(root);
  assert.equal(unchanged.revision, 3);
  assert.equal(unchanged.tickets["PROJ-9"].tasks["01"].status, "in_progress");

  const manifestDir = path.join(root, "evidence", "PROJ-9", "01");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    path.join(manifestDir, "manifest.json"),
    `${JSON.stringify({
      ticket: "PROJ-9",
      task: "01",
      criteria: [{ id: "AC1", command: "node -e process.exit(0)", exitCode: 0, artifact: "out.txt" }],
    })}\n`,
  );
  const ready = await fstate(
    root,
    "task",
    "transition",
    "--ticket",
    "PROJ-9",
    "--task",
    "01",
    "--status",
    "ready_for_review",
    "--expected-revision",
    "3",
  );
  assert.equal(ready.code, EXIT_OK, ready.err);
  const withHook = await readState(root);
  assert.equal(withHook.tickets["PROJ-9"].hooks.length, 1);
  assert.equal(withHook.tickets["PROJ-9"].hooks[0].exitCode, 0);
  assert.equal(withHook.tickets["PROJ-9"].hooks[0].phase, "before");

  const wrap = await fstate(
    root,
    "transition",
    "--ticket",
    "PROJ-9",
    "--stage",
    "wrapup",
    "--status",
    "active",
    "--expected-revision",
    "4",
  );
  assert.equal(wrap.code, EXIT_INVALID);
  assert.match(wrap.err, /not done/);

  await fstate(root, "create", "--ticket", "UM-1", "--kind", "umbrella", "--expected-revision", "4");
  const umbrella = await fstate(
    root,
    "transition",
    "--ticket",
    "UM-1",
    "--stage",
    "wrapup",
    "--status",
    "active",
    "--expected-revision",
    "5",
  );
  assert.equal(umbrella.code, EXIT_OK, umbrella.err);
});

test("session record keeps one active runtime per session file", async () => {
  const root = await tempRoot();
  await fstate(root, "create", "--ticket", "PROJ-123", "--expected-revision", "0");
  const started = await fstate(
    root,
    "session",
    "record",
    "--ticket",
    "PROJ-123",
    "--session-id",
    "pi-session-1",
    "--session",
    "/tmp/pi-session-1.jsonl",
    "--stage",
    "work",
    "--status",
    "running",
    "--subagent-id",
    "runtime-a",
    "--pane-name",
    "PROJ-123 · work T01",
    "--expected-revision",
    "1",
  );
  assert.equal(started.code, EXIT_OK, started.err);
  const duplicate = await fstate(
    root,
    "session",
    "record",
    "--ticket",
    "PROJ-123",
    "--session-id",
    "other",
    "--session",
    "/tmp/pi-session-1.jsonl",
    "--stage",
    "work",
    "--status",
    "running",
    "--subagent-id",
    "runtime-b",
    "--expected-revision",
    "2",
  );
  assert.equal(duplicate.code, EXIT_INVALID);
  assert.match(duplicate.err, /active runtime already exists/);
  const state = await readState(root);
  assert.equal(state.tickets["PROJ-123"].sessions["pi-session-1"].subagentId, "runtime-a");
  assert.equal(state.revision, 2);
});

test("worktree path and github reconcile follow the configured ticket source", async () => {
  const root = await tempRoot();
  const printed = await fstate(root, "worktree", "path", "--repo", "demo-repo", "--ticket", "PROJ-123");
  assert.equal(printed.code, EXIT_OK, printed.err);
  assert.equal(printed.json.path, path.join(process.env.HOME, "demo-repo", "worktrees", "PROJ-123"));

  const bad = await fstate(root, "worktree", "path", "--repo", "demo/repo", "--ticket", "PROJ-123");
  assert.equal(bad.code, EXIT_INVALID);

  await fstate(root, "init", ...INIT_MODELS);
  const local = await fstate(root, "github", "reconcile", "--ticket", "PROJ-123");
  assert.equal(local.code, EXIT_INVALID);
  assert.match(local.err, /not the ticket source/);

  await fstate(root, "init", ...INIT_MODELS, "--github-cli", "true", "--github-repo", "acme/shop");
  await fstate(
    root,
    "create",
    "--ticket",
    "PROJ-123",
    "--source-kind",
    "github",
    "--source-ref",
    "https://github.com/acme/shop/issues/12",
    "--expected-revision",
    "0",
  );
  const tracker = await fstate(root, "github", "reconcile", "--ticket", "PROJ-123");
  assert.equal(tracker.code, EXIT_OK, tracker.err);
  assert.match(tracker.json.commands[0], /gh issue comment 12/);
  assert.match(tracker.json.commands[1], /in-progress/);

  await fstate(
    root,
    "create",
    "--ticket",
    "PROJ-124",
    "--kind",
    "concrete",
    "--parent",
    "PROJ-123",
    "--expected-revision",
    "1",
  );
  const dep = await fstate(
    root,
    "ticket",
    "depend",
    "--ticket",
    "PROJ-124",
    "--depends-on",
    "PROJ-123",
    "--expected-revision",
    "2",
  );
  assert.equal(dep.code, EXIT_OK, dep.err);
  assert.deepEqual(dep.json.dependsOn, ["PROJ-123"]);
});

test("sqlite v3 task graph migrates to schema 4", async () => {
  const root = await tempRoot();
  await mkdir(path.join(root, "db"), { recursive: true });
  const db = new DatabaseSync(stateDbPath(root));
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key, value) VALUES
      ('schemaVersion', '3'),
      ('storageVersion', '1'),
      ('revision', '1'),
      ('updatedAt', '2026-01-01T00:00:00Z');
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY,
      title TEXT,
      type TEXT,
      source_kind TEXT,
      source_ref TEXT,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      current_task TEXT,
      message TEXT,
      message_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      worktree_path TEXT,
      worktree_branch TEXT,
      worktree_base_branch TEXT,
      worktree_workspace_id TEXT
    );
    INSERT INTO tickets (id, stage, status, current_task) VALUES ('PROJ-1', 'work', 'active', '01');
    CREATE TABLE blockers (
      ticket_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      since TEXT NOT NULL,
      owner TEXT NOT NULL,
      task TEXT
    );
    CREATE TABLE tasks (
      ticket_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT CHECK (status IS NULL OR status IN ('pending','in_progress','ready_for_review','done','blocked')),
      review_round INTEGER,
      review_verdict TEXT,
      review_finding_count INTEGER,
      review_blocking_count INTEGER,
      review_updated_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (ticket_id, task_id)
    );
    INSERT INTO tasks (ticket_id, task_id, status) VALUES ('PROJ-1', '01', 'ready_for_review');
    CREATE TABLE task_blocked_by (
      ticket_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      blocked_by_task_id TEXT NOT NULL,
      PRIMARY KEY (ticket_id, task_id, blocked_by_task_id)
    );
    INSERT INTO task_blocked_by VALUES ('PROJ-1', '01', '00');
    CREATE TABLE sessions (
      ticket_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      task TEXT,
      round INTEGER,
      model TEXT,
      pane_id TEXT,
      pane_name TEXT,
      session_file TEXT,
      status TEXT NOT NULL,
      context_tokens INTEGER,
      context_window INTEGER,
      context_percent REAL,
      started_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (ticket_id, session_id)
    );
    CREATE TABLE usage (
      ticket_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      task TEXT,
      round INTEGER,
      model TEXT,
      through_entry_id TEXT,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      tokens_total INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      recorded_at TEXT,
      PRIMARY KEY (ticket_id, session_id)
    );
    CREATE TABLE events (
      revision INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      op TEXT NOT NULL,
      ticket_id TEXT,
      task_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}'
    );
  `);
  db.close();

  const moved = await fstate(
    root,
    "task",
    "transition",
    "--ticket",
    "PROJ-1",
    "--task",
    "01",
    "--status",
    "in_review",
    "--expected-revision",
    "1",
  );
  assert.equal(moved.code, EXIT_OK, moved.err);
  const state = await readState(root);
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.tickets["PROJ-1"].tasks["01"].status, "in_review");
  assert.deepEqual(state.tickets["PROJ-1"].tasks["01"].blockedBy, ["00"]);
  assert.equal(state.tickets["PROJ-1"].currentTask, "01");
});
