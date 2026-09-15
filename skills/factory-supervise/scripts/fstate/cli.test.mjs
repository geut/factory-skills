import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  EXIT_ARGS,
  EXIT_INVALID,
  EXIT_IO,
  EXIT_NOT_FOUND,
  EXIT_OK,
  main,
} from "./cli.mjs";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "recap-after-contract.jsonl");
const roots = [];

async function tempRoot() {
  const dir = await mkdtemp(path.join(tmpdir(), "fstate-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
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
  return JSON.parse(await readFile(path.join(root, "FACTORY-STATE.json"), "utf8"));
}

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

  const status = await fstate(root, "status", "--ticket", "PROJ-123");
  assert.equal(status.code, EXIT_OK, status.err);
  assert.equal(status.json.revision, 1);
  assert.equal(status.json.state.title, "Restore the saved catalog filter");
  assert.equal(status.json.state.worktree.branch, "PROJ-123");
  assert.equal(status.json.state.source.kind, "github");
});

test("transition with wrong expected-revision does not change the file", async () => {
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
  assert.deepEqual(after, before);
  assert.equal(after.revision, 1);
  assert.equal(after.tickets["PROJ-123"].stage, "plan");
});

test("lock wx fails while a lock file exists", async () => {
  const root = await tempRoot();
  await writeFile(path.join(root, "FACTORY-STATE.json.lock"), "stale");
  const result = await fstate(root, "create", "--ticket", "PROJ-1", "--expected-revision", "0");
  assert.equal(result.code, EXIT_IO);
  assert.match(result.err, /lock busy/);
});

test("task, review, session, message, block, and unblock", async () => {
  const root = await tempRoot();
  await fstate(root, "create", "--ticket", "PROJ-123", "--expected-revision", "0");

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
    "1",
  );
  assert.equal(task.code, EXIT_OK, task.err);
  assert.equal(task.json.revision, 2);
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
    "2",
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
    "3",
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
    "4",
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
    "5",
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
    "6",
  );
  assert.equal(unblocked.code, EXIT_OK, unblocked.err);
  assert.equal(unblocked.json.status, "active");
  assert.equal(unblocked.json.blocker, null);

  const state = await readState(root);
  assert.equal(state.revision, 7);
  assert.equal(state.tickets["PROJ-123"].currentTask, "01");
  assert.equal(state.tickets["PROJ-123"].tasks["01"].review.round, 1);
  assert.equal(state.tickets["PROJ-123"].sessions["sess-1"].paneName, "PROJ-123 · review T01 R1");
  assert.equal(state.tickets["PROJ-123"].message, "Review task 01 completed");
  assert.equal(state.tickets["PROJ-123"].blocker, null);
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

test("v2 file migrates to v3 on the next mutation; unknown fields stay null", async () => {
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

  const state = await readState(root);
  assert.equal(state.schemaVersion, 3);
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

test("status and validate of a missing file exit 3", async () => {
  const root = await tempRoot();
  const status = await fstate(root, "status");
  assert.equal(status.code, EXIT_NOT_FOUND);
  const validated = await fstate(root, "validate");
  assert.equal(validated.code, EXIT_NOT_FOUND);
});

test("unknown command and missing mutation flags exit 2", async () => {
  const root = await tempRoot();
  const unknown = await fstate(root, "nope");
  assert.equal(unknown.code, EXIT_ARGS);
  const missing = await fstate(root, "create", "--expected-revision", "0");
  assert.equal(missing.code, EXIT_ARGS);
  assert.match(missing.err, /--ticket is required/);
});

test("validate accepts a well-formed file", async () => {
  const root = await tempRoot();
  await fstate(root, "create", "--ticket", "PROJ-123", "--expected-revision", "0");
  const result = await fstate(root, "validate");
  assert.equal(result.code, EXIT_OK, result.err);
  assert.deepEqual(result.json.tickets, ["PROJ-123"]);
  assert.equal(result.json.schemaVersion, 3);
});
