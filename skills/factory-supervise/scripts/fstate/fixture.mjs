/**
 * Representative test board for `fstate seed`. Timestamps are fixed.
 * seedFixture writes them directly and does not go through mutate.
 */
const HOME = "/Users/deka";
const REPO = "catalog";
const GH = "https://github.com/acme/catalog";
const WORK = "anthropic/claude-sonnet-4-5";
const REVIEW = "anthropic/claude-opus-4-6";
const HOOK = 'node "skills/factory-supervise/scripts/fstate/hooks/require-evidence.mjs"';
const TASK_TOUCH = new Set(["task_register", "task_transition", "review_record"]);

const worktree = (id) => `${HOME}/${REPO}/worktrees/${id}`;
const sessionFile = (id) => `${HOME}/.pi/agent/sessions/${id}.jsonl`;
const evidence = (ticket, task) => `.factory/evidence/${ticket}/${task}/manifest.json`;

const tickets = [
  {
    id: "PROJ-14",
    title: "Pin catalog search to the saved filter",
    type: "feature",
    source_kind: "github",
    source_ref: `${GH}/issues/14`,
    stage: "done",
    status: "complete",
    current_task: null,
    message: "Wrap-up handoff recorded.",
    created_at: "2026-09-24T14:02:11Z",
    worktree_path: worktree("PROJ-14"),
    worktree_branch: "PROJ-14",
    worktree_base_branch: "main",
    worktree_workspace_id: "w14",
    parent_id: null,
    kind: "concrete",
  },
  {
    id: "PROJ-22",
    title: "Export the filtered catalog as CSV",
    type: "feature",
    source_kind: "github",
    source_ref: `${GH}/issues/22`,
    stage: "work",
    status: "blocked",
    current_task: "01",
    message: "Blocked on the CSV column set. Need a decision before task 02.",
    created_at: "2026-09-26T09:15:40Z",
    worktree_path: worktree("PROJ-22"),
    worktree_branch: "PROJ-22",
    worktree_base_branch: "main",
    worktree_workspace_id: "w22",
    parent_id: null,
    kind: "concrete",
  },
  {
    id: "PROJ-29",
    title: "Restore keyboard focus after the filter is applied",
    type: "bug",
    source_kind: "github",
    source_ref: `${GH}/issues/29`,
    stage: "review",
    status: "active",
    current_task: "02",
    message: "Reviewing task 02.",
    created_at: "2026-09-29T11:08:22Z",
    worktree_path: worktree("PROJ-29"),
    worktree_branch: "PROJ-29",
    worktree_base_branch: "main",
    worktree_workspace_id: "w29",
    parent_id: null,
    kind: "concrete",
  },
  {
    id: "PROJ-38",
    title: "Show an empty state when search has no hits",
    type: "feature",
    source_kind: "github",
    source_ref: `${GH}/issues/38`,
    stage: "work",
    status: "active",
    current_task: "02",
    message: "Task 01 is ready for review. Task 02 is in progress.",
    created_at: "2026-09-30T16:44:03Z",
    worktree_path: worktree("PROJ-38"),
    worktree_branch: "PROJ-38",
    worktree_base_branch: "main",
    worktree_workspace_id: "w38",
    parent_id: null,
    kind: "concrete",
  },
  {
    id: "PROJ-41",
    title: "Document the filter query parameters",
    type: "docs",
    source_kind: "github",
    source_ref: `${GH}/issues/41`,
    stage: "plan",
    status: "waiting_for_user",
    current_task: null,
    message: "Plan drafted q, sort, and saved. Confirm the names before work starts.",
    created_at: "2026-10-01T13:27:55Z",
    worktree_path: worktree("PROJ-41"),
    worktree_branch: "PROJ-41",
    worktree_base_branch: "main",
    worktree_workspace_id: "w41",
    parent_id: null,
    kind: "concrete",
  },
];

const tasks = [
  task("PROJ-14", "01", "done", {
    artifact: "src/catalog/saved-filter.ts",
    evidence: evidence("PROJ-14", "01"),
    profile: "unit",
    review: [1, "approve", 0, 0],
  }),
  task("PROJ-14", "02", "done", {
    artifact: "src/catalog/apply-filter.ts",
    evidence: evidence("PROJ-14", "02"),
    profile: "unit",
    review: [2, "approve", 1, 0],
    blockedBy: ["01"],
  }),
  task("PROJ-14", "03", "done", {
    artifact: "src/catalog/filter-query.ts",
    evidence: evidence("PROJ-14", "03"),
    profile: "unit",
    review: [1, "approve", 0, 0],
    blockedBy: ["02"],
  }),
  task("PROJ-22", "01", "blocked", {
    artifact: "src/catalog/export-csv.ts",
    profile: "unit",
  }),
  task("PROJ-22", "02", "pending", {
    artifact: "src/catalog/export-csv-ui.tsx",
    profile: "unit",
    blockedBy: ["01"],
  }),
  task("PROJ-29", "01", "done", {
    artifact: "src/catalog/filter-focus.ts",
    evidence: evidence("PROJ-29", "01"),
    profile: "unit",
    review: [1, "approve", 2, 0],
  }),
  task("PROJ-29", "02", "in_review", {
    artifact: "src/catalog/filter-focus.ts",
    evidence: evidence("PROJ-29", "02"),
    profile: "unit",
    blockedBy: ["01"],
  }),
  task("PROJ-29", "03", "pending", {
    artifact: "src/catalog/filter-announce.ts",
    profile: "unit",
    blockedBy: ["02"],
  }),
  task("PROJ-38", "01", "ready_for_review", {
    artifact: "src/catalog/empty-state.tsx",
    evidence: evidence("PROJ-38", "01"),
    profile: "unit",
  }),
  task("PROJ-38", "02", "in_progress", {
    artifact: "src/catalog/empty-state.tsx",
    profile: "unit",
  }),
  task("PROJ-41", "01", "pending", {
    artifact: "docs/filter-query.md",
  }),
];

const blockers = [
  {
    ticket_id: "PROJ-22",
    reason: "CSV column set is undecided: internal SKUs, or only the columns shown in the catalog table.",
    since: "2026-09-26T11:52:18Z",
    owner: "user",
    task: "01",
  },
];

const ticketDepends = [{ ticket_id: "PROJ-38", depends_on_ticket_id: "PROJ-14" }];

const sessions = [
  sess("PROJ-14", "pi-14-plan", "plan", null, null, "completed", "2026-09-24T14:02:18Z", "sub-14-plan", "p14plan", "PROJ-14 · plan"),
  sess("PROJ-14", "pi-14-w01", "work", "01", 1, "completed", "2026-09-24T14:20:20Z", "sub-14-w01", "p14w01", "PROJ-14 · work T01"),
  sess("PROJ-14", "pi-14-r01", "review", "01", 1, "completed", "2026-09-24T15:55:12Z", "sub-14-r01", "p14r01", "PROJ-14 · review T01 R1"),
  sess("PROJ-14", "pi-14-w02a", "work", "02", 1, "completed", "2026-09-24T16:18:44Z", "sub-14-w02a", "p14w02", "PROJ-14 · work T02 R1"),
  sess("PROJ-14", "pi-14-r02a", "review", "02", 1, "completed", "2026-09-24T17:41:08Z", "sub-14-r02a", "p14r02", "PROJ-14 · review T02 R1"),
  sess("PROJ-14", "pi-14-w02b", "work", "02", 2, "completed", "2026-09-25T09:12:00Z", "sub-14-w02b", "p14w02b", "PROJ-14 · work T02 R2"),
  sess("PROJ-14", "pi-14-r02b", "review", "02", 2, "completed", "2026-09-25T10:14:50Z", "sub-14-r02b", "p14r02b", "PROJ-14 · review T02 R2"),
  sess("PROJ-14", "pi-14-w03", "work", "03", 1, "completed", "2026-09-25T10:40:06Z", "sub-14-w03", "p14w03", "PROJ-14 · work T03"),
  sess("PROJ-14", "pi-14-r03", "review", "03", 1, "completed", "2026-09-25T13:02:20Z", "sub-14-r03", "p14r03", "PROJ-14 · review T03 R1"),
  sess("PROJ-14", "pi-14-wrap", "wrapup", null, null, "completed", "2026-09-25T13:30:05Z", "sub-14-wrap", "p14wrap", "PROJ-14 · wrapup"),
  sess("PROJ-22", "pi-22-plan", "plan", null, null, "completed", "2026-09-26T09:15:48Z", "sub-22-plan", "p22plan", "PROJ-22 · plan"),
  sess("PROJ-22", "pi-22-w01", "work", "01", 1, "failed", "2026-09-26T09:31:08Z", "sub-22-w01", "p22w01", "PROJ-22 · work T01"),
  sess("PROJ-29", "pi-29-plan", "plan", null, null, "completed", "2026-09-29T11:08:30Z", "sub-29-plan", "p29plan", "PROJ-29 · plan"),
  sess("PROJ-29", "pi-29-w01", "work", "01", 1, "completed", "2026-09-29T11:30:16Z", "sub-29-w01", "p29w01", "PROJ-29 · work T01"),
  sess("PROJ-29", "pi-29-r01", "review", "01", 1, "completed", "2026-09-29T14:10:14Z", "sub-29-r01", "p29r01", "PROJ-29 · review T01 R1"),
  sess("PROJ-29", "pi-29-w02", "work", "02", 1, "completed", "2026-09-29T14:40:26Z", "sub-29-w02", "p29w02", "PROJ-29 · work T02"),
  sess("PROJ-29", "pi-29-r02", "review", "02", 1, "running", "2026-10-01T19:02:16Z", "sub-29-r02", "p29r02", "PROJ-29 · review T02 R1"),
  sess("PROJ-38", "pi-38-plan", "plan", null, null, "completed", "2026-09-30T16:44:10Z", "sub-38-plan", "p38plan", "PROJ-38 · plan"),
  sess("PROJ-38", "pi-38-w01", "work", "01", 1, "completed", "2026-09-30T17:06:14Z", "sub-38-w01", "p38w01", "PROJ-38 · work T01"),
  sess("PROJ-38", "pi-38-w02", "work", "02", 1, "running", "2026-10-02T09:41:05Z", "sub-38-w02", "p38w02", "PROJ-38 · work T02"),
  sess("PROJ-41", "pi-41-plan", "plan", null, null, "waiting_for_user", "2026-10-01T13:40:02Z", "sub-41-plan", "p41plan", "PROJ-41 · plan"),
];

const usage = [
  use("PROJ-14", "pi-14-plan", "plan", null, null, WORK, "entry-14-plan", 1200, 1800, 14000, 3200, 0.064, "2026-09-24T14:11:41Z"),
  use("PROJ-14", "pi-14-w01", "work", "01", 1, WORK, "entry-14-w01", 2400, 9100, 86000, 22000, 0.412, "2026-09-24T15:48:23Z"),
  use("PROJ-14", "pi-14-r01", "review", "01", 1, REVIEW, "entry-14-r01", 900, 2400, 41000, 6000, 0.188, "2026-09-24T16:11:49Z"),
  use("PROJ-14", "pi-14-w02a", "work", "02", 1, WORK, "entry-14-w02a", 2600, 10400, 92000, 25000, 0.468, "2026-09-24T17:36:13Z"),
  use("PROJ-14", "pi-14-r02a", "review", "02", 1, REVIEW, "entry-14-r02a", 1100, 3100, 48000, 7000, 0.221, "2026-09-24T17:58:34Z"),
  use("PROJ-14", "pi-14-w02b", "work", "02", 2, WORK, "entry-14-w02b", 1800, 4200, 54000, 9000, 0.196, "2026-09-25T10:06:15Z"),
  use("PROJ-14", "pi-14-r02b", "review", "02", 2, REVIEW, "entry-14-r02b", 800, 1600, 39000, 4500, 0.142, "2026-09-25T10:29:06Z"),
  use("PROJ-14", "pi-14-w03", "work", "03", 1, WORK, "entry-14-w03", 2100, 7600, 73000, 18000, 0.337, "2026-09-25T12:15:45Z"),
  use("PROJ-14", "pi-14-r03", "review", "03", 1, REVIEW, "entry-14-r03", 700, 1900, 36000, 5000, 0.151, "2026-09-25T13:21:41Z"),
  use("PROJ-14", "pi-14-wrap", "wrapup", null, null, WORK, "entry-14-wrap", 1600, 2800, 22000, 4000, 0.098, "2026-09-25T13:44:23Z"),
  use("PROJ-22", "pi-22-plan", "plan", null, null, WORK, "entry-22-plan", 980, 1500, 11000, 2800, 0.051, "2026-09-26T09:28:12Z"),
  use("PROJ-22", "pi-22-w01", "work", "01", 1, WORK, "entry-22-w01", 1900, 3400, 27000, 8000, 0.124, "2026-09-26T11:40:56Z"),
  use("PROJ-29", "pi-29-plan", "plan", null, null, WORK, "entry-29-plan", 1100, 1700, 13000, 3000, 0.058, "2026-09-29T11:24:51Z"),
  use("PROJ-29", "pi-29-w01", "work", "01", 1, WORK, "entry-29-w01", 2200, 6800, 61000, 16000, 0.286, "2026-09-29T14:02:41Z"),
  use("PROJ-29", "pi-29-r01", "review", "01", 1, REVIEW, "entry-29-r01", 900, 2200, 40000, 5500, 0.171, "2026-09-29T14:28:17Z"),
  use("PROJ-29", "pi-29-w02", "work", "02", 1, WORK, "entry-29-w02", 2500, 8900, 84000, 21000, 0.389, "2026-09-30T16:05:34Z"),
  use("PROJ-38", "pi-38-plan", "plan", null, null, WORK, "entry-38-plan", 1000, 1400, 10000, 2600, 0.047, "2026-09-30T16:58:41Z"),
  use("PROJ-38", "pi-38-w01", "work", "01", 1, WORK, "entry-38-w01", 2300, 7200, 69000, 17000, 0.301, "2026-10-01T18:12:45Z"),
  use("PROJ-41", "pi-41-plan", "plan", null, null, WORK, "entry-41-plan", 800, 1100, 9000, 2200, 0.039, "2026-10-02T08:16:41Z"),
];

const events = [
  ev("2026-09-24T14:02:11Z", "create", "PROJ-14", null, { stage: "plan", status: "active", kind: "concrete" }),
  ev("2026-09-24T14:11:40Z", "session_record", "PROJ-14", null, { session: "pi-14-plan", status: "completed" }),
  ev("2026-09-24T14:11:41Z", "usage_record", "PROJ-14", null, { session: "pi-14-plan", stage: "plan", costUsd: 0.064 }),
  ev("2026-09-24T14:12:05Z", "message", "PROJ-14", null, { message: "Plan accepted. Three tasks, sequential." }),
  ev("2026-09-24T14:12:06Z", "transition", "PROJ-14", null, { stage: "work", status: "active" }),
  ev("2026-09-24T14:12:08Z", "task_register", "PROJ-14", "01", { status: "pending", currentTask: null }),
  ev("2026-09-24T14:12:09Z", "task_register", "PROJ-14", "02", { status: "pending", currentTask: null }),
  ev("2026-09-24T14:12:10Z", "task_register", "PROJ-14", "03", { status: "pending", currentTask: null }),
  ev("2026-09-24T14:20:16Z", "task_transition", "PROJ-14", "01", { status: "in_progress", from: "pending", currentTask: "01" }),
  ev("2026-09-24T15:48:22Z", "session_record", "PROJ-14", "01", { session: "pi-14-w01", status: "completed" }),
  ev("2026-09-24T15:48:23Z", "usage_record", "PROJ-14", "01", { session: "pi-14-w01", stage: "work", costUsd: 0.412 }),
  ev("2026-09-24T15:48:30Z", "task_transition", "PROJ-14", "01", { status: "ready_for_review", from: "in_progress", currentTask: "01" }, "task:ready_for_review"),
  ev("2026-09-24T15:55:02Z", "transition", "PROJ-14", null, { stage: "review", status: "active" }),
  ev("2026-09-24T15:55:10Z", "task_transition", "PROJ-14", "01", { status: "in_review", from: "ready_for_review", currentTask: "01" }),
  ev("2026-09-24T16:11:48Z", "session_record", "PROJ-14", "01", { session: "pi-14-r01", status: "completed" }),
  ev("2026-09-24T16:11:49Z", "usage_record", "PROJ-14", "01", { session: "pi-14-r01", stage: "review", costUsd: 0.188 }),
  ev("2026-09-24T16:11:55Z", "review_record", "PROJ-14", "01", { round: 1, verdict: "approve" }),
  ev("2026-09-24T16:12:01Z", "task_transition", "PROJ-14", "01", { status: "done", from: "in_review", currentTask: null }),
  ev("2026-09-24T16:18:40Z", "task_transition", "PROJ-14", "02", { status: "in_progress", from: "pending", currentTask: "02" }),
  ev("2026-09-24T17:36:12Z", "session_record", "PROJ-14", "02", { session: "pi-14-w02a", status: "completed" }),
  ev("2026-09-24T17:36:13Z", "usage_record", "PROJ-14", "02", { session: "pi-14-w02a", stage: "work", costUsd: 0.468 }),
  ev("2026-09-24T17:36:20Z", "task_transition", "PROJ-14", "02", { status: "ready_for_review", from: "in_progress", currentTask: "02" }, "task:ready_for_review"),
  ev("2026-09-24T17:41:05Z", "task_transition", "PROJ-14", "02", { status: "in_review", from: "ready_for_review", currentTask: "02" }),
  ev("2026-09-24T17:58:33Z", "session_record", "PROJ-14", "02", { session: "pi-14-r02a", status: "completed" }),
  ev("2026-09-24T17:58:34Z", "usage_record", "PROJ-14", "02", { session: "pi-14-r02a", stage: "review", costUsd: 0.221 }),
  ev("2026-09-24T17:58:40Z", "review_record", "PROJ-14", "02", { round: 1, verdict: "changes_requested" }),
  ev("2026-09-24T17:58:46Z", "task_transition", "PROJ-14", "02", { status: "in_progress", from: "in_review", currentTask: "02" }),
  ev("2026-09-25T10:06:14Z", "session_record", "PROJ-14", "02", { session: "pi-14-w02b", status: "completed" }),
  ev("2026-09-25T10:06:15Z", "usage_record", "PROJ-14", "02", { session: "pi-14-w02b", stage: "work", costUsd: 0.196 }),
  ev("2026-09-25T10:06:22Z", "task_transition", "PROJ-14", "02", { status: "ready_for_review", from: "in_progress", currentTask: "02" }, "task:ready_for_review"),
  ev("2026-09-25T10:14:48Z", "task_transition", "PROJ-14", "02", { status: "in_review", from: "ready_for_review", currentTask: "02" }),
  ev("2026-09-25T10:29:05Z", "session_record", "PROJ-14", "02", { session: "pi-14-r02b", status: "completed" }),
  ev("2026-09-25T10:29:06Z", "usage_record", "PROJ-14", "02", { session: "pi-14-r02b", stage: "review", costUsd: 0.142 }),
  ev("2026-09-25T10:29:11Z", "review_record", "PROJ-14", "02", { round: 2, verdict: "approve" }),
  ev("2026-09-25T10:29:18Z", "task_transition", "PROJ-14", "02", { status: "done", from: "in_review", currentTask: null }),
  ev("2026-09-25T10:40:02Z", "task_transition", "PROJ-14", "03", { status: "in_progress", from: "pending", currentTask: "03" }),
  ev("2026-09-25T12:15:44Z", "session_record", "PROJ-14", "03", { session: "pi-14-w03", status: "completed" }),
  ev("2026-09-25T12:15:45Z", "usage_record", "PROJ-14", "03", { session: "pi-14-w03", stage: "work", costUsd: 0.337 }),
  ev("2026-09-25T12:15:51Z", "task_transition", "PROJ-14", "03", { status: "ready_for_review", from: "in_progress", currentTask: "03" }, "task:ready_for_review"),
  ev("2026-09-25T13:02:18Z", "task_transition", "PROJ-14", "03", { status: "in_review", from: "ready_for_review", currentTask: "03" }),
  ev("2026-09-25T13:21:40Z", "session_record", "PROJ-14", "03", { session: "pi-14-r03", status: "completed" }),
  ev("2026-09-25T13:21:41Z", "usage_record", "PROJ-14", "03", { session: "pi-14-r03", stage: "review", costUsd: 0.151 }),
  ev("2026-09-25T13:21:47Z", "review_record", "PROJ-14", "03", { round: 1, verdict: "approve" }),
  ev("2026-09-25T13:21:53Z", "task_transition", "PROJ-14", "03", { status: "done", from: "in_review", currentTask: null }),
  ev("2026-09-25T13:30:00Z", "transition", "PROJ-14", null, { stage: "wrapup", status: "active" }, "ticket:wrapup"),
  ev("2026-09-25T13:44:22Z", "session_record", "PROJ-14", null, { session: "pi-14-wrap", status: "completed" }),
  ev("2026-09-25T13:44:23Z", "usage_record", "PROJ-14", null, { session: "pi-14-wrap", stage: "wrapup", costUsd: 0.098 }),
  ev("2026-09-25T13:44:30Z", "message", "PROJ-14", null, { message: "Wrap-up handoff recorded." }),
  ev("2026-09-25T13:52:16Z", "transition", "PROJ-14", null, { stage: "done", status: "complete" }),

  ev("2026-09-26T09:15:40Z", "create", "PROJ-22", null, { stage: "plan", status: "active", kind: "concrete" }),
  ev("2026-09-26T09:28:11Z", "session_record", "PROJ-22", null, { session: "pi-22-plan", status: "completed" }),
  ev("2026-09-26T09:28:12Z", "usage_record", "PROJ-22", null, { session: "pi-22-plan", stage: "plan", costUsd: 0.051 }),
  ev("2026-09-26T09:28:20Z", "message", "PROJ-22", null, { message: "Plan accepted. Export columns, then the download action." }),
  ev("2026-09-26T09:28:21Z", "transition", "PROJ-22", null, { stage: "work", status: "active" }),
  ev("2026-09-26T09:28:22Z", "task_register", "PROJ-22", "01", { status: "pending", currentTask: null }),
  ev("2026-09-26T09:28:23Z", "task_register", "PROJ-22", "02", { status: "pending", currentTask: null }),
  ev("2026-09-26T09:31:04Z", "task_transition", "PROJ-22", "01", { status: "in_progress", from: "pending", currentTask: "01" }),
  ev("2026-09-26T11:40:55Z", "session_record", "PROJ-22", "01", { session: "pi-22-w01", status: "failed" }),
  ev("2026-09-26T11:40:56Z", "usage_record", "PROJ-22", "01", { session: "pi-22-w01", stage: "work", costUsd: 0.124 }),
  ev("2026-09-26T11:48:02Z", "task_transition", "PROJ-22", "01", { status: "blocked", from: "in_progress", currentTask: "01" }),
  ev("2026-09-26T11:48:10Z", "message", "PROJ-22", null, { message: "Blocked on the CSV column set. Need a decision before task 02." }),
  ev("2026-09-26T11:52:18Z", "block", "PROJ-22", "01", {
    status: "blocked",
    blocker: {
      reason: "CSV column set is undecided: internal SKUs, or only the columns shown in the catalog table.",
      since: "2026-09-26T11:52:18Z",
      owner: "user",
      task: "01",
    },
  }),

  ev("2026-09-29T11:08:22Z", "create", "PROJ-29", null, { stage: "plan", status: "active", kind: "concrete" }),
  ev("2026-09-29T11:24:50Z", "session_record", "PROJ-29", null, { session: "pi-29-plan", status: "completed" }),
  ev("2026-09-29T11:24:51Z", "usage_record", "PROJ-29", null, { session: "pi-29-plan", stage: "plan", costUsd: 0.058 }),
  ev("2026-09-29T11:24:58Z", "message", "PROJ-29", null, { message: "Plan accepted. Focus restore, then the result announcement." }),
  ev("2026-09-29T11:24:59Z", "transition", "PROJ-29", null, { stage: "work", status: "active" }),
  ev("2026-09-29T11:25:02Z", "task_register", "PROJ-29", "01", { status: "pending", currentTask: null }),
  ev("2026-09-29T11:25:03Z", "task_register", "PROJ-29", "02", { status: "pending", currentTask: null }),
  ev("2026-09-29T11:25:04Z", "task_register", "PROJ-29", "03", { status: "pending", currentTask: null }),
  ev("2026-09-29T11:30:12Z", "task_transition", "PROJ-29", "01", { status: "in_progress", from: "pending", currentTask: "01" }),
  ev("2026-09-29T14:02:40Z", "session_record", "PROJ-29", "01", { session: "pi-29-w01", status: "completed" }),
  ev("2026-09-29T14:02:41Z", "usage_record", "PROJ-29", "01", { session: "pi-29-w01", stage: "work", costUsd: 0.286 }),
  ev("2026-09-29T14:02:48Z", "task_transition", "PROJ-29", "01", { status: "ready_for_review", from: "in_progress", currentTask: "01" }, "task:ready_for_review"),
  ev("2026-09-29T14:10:05Z", "transition", "PROJ-29", null, { stage: "review", status: "active" }),
  ev("2026-09-29T14:10:12Z", "task_transition", "PROJ-29", "01", { status: "in_review", from: "ready_for_review", currentTask: "01" }),
  ev("2026-09-29T14:28:16Z", "session_record", "PROJ-29", "01", { session: "pi-29-r01", status: "completed" }),
  ev("2026-09-29T14:28:17Z", "usage_record", "PROJ-29", "01", { session: "pi-29-r01", stage: "review", costUsd: 0.171 }),
  ev("2026-09-29T14:28:19Z", "review_record", "PROJ-29", "01", { round: 1, verdict: "approve" }),
  ev("2026-09-29T14:28:20Z", "task_transition", "PROJ-29", "01", { status: "done", from: "in_review", currentTask: null }),
  ev("2026-09-29T14:40:22Z", "task_transition", "PROJ-29", "02", { status: "in_progress", from: "pending", currentTask: "02" }),
  ev("2026-09-30T16:05:33Z", "session_record", "PROJ-29", "02", { session: "pi-29-w02", status: "completed" }),
  ev("2026-09-30T16:05:34Z", "usage_record", "PROJ-29", "02", { session: "pi-29-w02", stage: "work", costUsd: 0.389 }),
  ev("2026-09-30T16:05:41Z", "task_transition", "PROJ-29", "02", { status: "ready_for_review", from: "in_progress", currentTask: "02" }, "task:ready_for_review"),

  ev("2026-09-30T16:44:03Z", "create", "PROJ-38", null, { stage: "plan", status: "active", kind: "concrete" }),
  ev("2026-09-30T16:44:20Z", "ticket_depend", "PROJ-38", null, { dependsOn: ["PROJ-14"] }),
  ev("2026-09-30T16:58:40Z", "session_record", "PROJ-38", null, { session: "pi-38-plan", status: "completed" }),
  ev("2026-09-30T16:58:41Z", "usage_record", "PROJ-38", null, { session: "pi-38-plan", stage: "plan", costUsd: 0.047 }),
  ev("2026-09-30T16:58:50Z", "message", "PROJ-38", null, { message: "Plan accepted. Empty state copy and the zero-hit layout can land together." }),
  ev("2026-09-30T16:58:51Z", "transition", "PROJ-38", null, { stage: "work", status: "active" }),
  ev("2026-09-30T16:58:52Z", "task_register", "PROJ-38", "01", { status: "pending", currentTask: null }),
  ev("2026-09-30T16:58:53Z", "task_register", "PROJ-38", "02", { status: "pending", currentTask: null }),
  ev("2026-09-30T17:06:11Z", "task_transition", "PROJ-38", "01", { status: "in_progress", from: "pending", currentTask: "01" }),

  ev("2026-10-01T13:27:55Z", "create", "PROJ-41", null, { stage: "plan", status: "active", kind: "concrete" }),
  ev("2026-10-01T13:41:12Z", "task_register", "PROJ-41", "01", { status: "pending", currentTask: null }),
  ev("2026-10-01T18:12:44Z", "session_record", "PROJ-38", "01", { session: "pi-38-w01", status: "completed" }),
  ev("2026-10-01T18:12:45Z", "usage_record", "PROJ-38", "01", { session: "pi-38-w01", stage: "work", costUsd: 0.301 }),
  ev("2026-10-01T18:12:52Z", "task_transition", "PROJ-38", "01", { status: "ready_for_review", from: "in_progress", currentTask: "01" }, "task:ready_for_review"),
  ev("2026-10-01T19:02:11Z", "message", "PROJ-29", null, { message: "Reviewing task 02." }),
  ev("2026-10-01T19:02:14Z", "task_transition", "PROJ-29", "02", { status: "in_review", from: "ready_for_review", currentTask: "02" }),
  ev("2026-10-01T19:02:16Z", "session_record", "PROJ-29", "02", { session: "pi-29-r02", status: "running" }),
  ev("2026-10-01T19:14:06Z", "session_record", "PROJ-29", "02", { session: "pi-29-r02", status: "running" }),

  ev("2026-10-02T08:16:40Z", "session_record", "PROJ-41", null, { session: "pi-41-plan", status: "waiting_for_user" }),
  ev("2026-10-02T08:16:41Z", "usage_record", "PROJ-41", null, { session: "pi-41-plan", stage: "plan", costUsd: 0.039 }),
  ev("2026-10-02T08:16:42Z", "message", "PROJ-41", null, { message: "Plan drafted q, sort, and saved. Confirm the names before work starts." }),
  ev("2026-10-02T08:16:43Z", "transition", "PROJ-41", null, { stage: "plan", status: "waiting_for_user" }),
  ev("2026-10-02T09:41:02Z", "task_transition", "PROJ-38", "02", { status: "in_progress", from: "pending", currentTask: "02" }),
  ev("2026-10-02T09:41:05Z", "session_record", "PROJ-38", "02", { session: "pi-38-w02", status: "running" }),
  ev("2026-10-02T09:41:08Z", "message", "PROJ-38", null, { message: "Task 01 is ready for review. Task 02 is in progress." }),
  ev("2026-10-02T11:48:17Z", "session_record", "PROJ-38", "02", { session: "pi-38-w02", status: "running" }),
];

function assertFixture() {
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].at <= events[i - 1].at) {
      throw new Error(`fixture events are not chronological at ${events[i].at}`);
    }
  }
  for (const ticket of tickets) {
    const owned = events.filter((event) => event.ticket === ticket.id);
    if (owned.at(-1).at !== ticketUpdatedAt(ticket.id)) {
      throw new Error(`${ticket.id} updated_at mismatch`);
    }
    const created = owned.find((event) => event.op === "create");
    if (created.at !== ticket.created_at) {
      throw new Error(`${ticket.id} created_at mismatch`);
    }
    const progress = expectedStageStatus(ticket.id);
    if (ticket.stage !== progress.stage || ticket.status !== progress.status) {
      throw new Error(`${ticket.id} stage/status ${ticket.stage}/${ticket.status} != ${progress.stage}/${progress.status}`);
    }
    if (ticket.current_task !== expectedCurrentTask(ticket.id)) {
      throw new Error(`${ticket.id} current_task mismatch`);
    }
    const message = [...owned].reverse().find((event) => event.op === "message");
    if (message.payload.message !== ticket.message) {
      throw new Error(`${ticket.id} message mismatch`);
    }
  }
  for (const row of tasks) {
    if (row.status !== expectedTaskStatus(row.ticket_id, row.task_id)) {
      throw new Error(`${row.ticket_id} ${row.task_id} status mismatch`);
    }
  }
  for (const row of blockers) {
    const block = [...events].reverse().find((event) => event.ticket === row.ticket_id && event.op === "block");
    if (block.at !== row.since) {
      throw new Error(`${row.ticket_id} blocker since mismatch`);
    }
  }
  const sessionIds = new Set(sessions.map((row) => row.session_id));
  const recordedSessions = new Set(
    events.filter((event) => event.op === "session_record").map((event) => event.payload.session),
  );
  if (sessionIds.size !== recordedSessions.size || [...sessionIds].some((id) => !recordedSessions.has(id))) {
    throw new Error("fixture sessions do not match session_record events");
  }
  for (const row of sessions) {
    if (sessionUpdatedAt(row.session_id) <= row.started_at) {
      throw new Error(`${row.session_id} updated_at is not after started_at`);
    }
  }
  const usageIds = new Set(usage.map((row) => row.session_id));
  const recordedUsage = new Set(
    events.filter((event) => event.op === "usage_record").map((event) => event.payload.session),
  );
  if (usageIds.size !== recordedUsage.size || [...usageIds].some((id) => !recordedUsage.has(id))) {
    throw new Error("fixture usage does not match usage_record events");
  }
  const running = new Set(sessions.filter((row) => row.status === "running").map((row) => row.session_id));
  for (const id of running) {
    if (usageIds.has(id)) {
      throw new Error(`${id} is running and must not have usage`);
    }
  }
}

export function seedFixture(db) {
  assertFixture();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM hook_runs");
    db.exec("DELETE FROM events");
    db.exec("DELETE FROM ticket_depends");
    db.exec("DELETE FROM tickets");

    const insertTicket = db.prepare(`
      INSERT INTO tickets (
        id, title, type, source_kind, source_ref, stage, status, current_task,
        message, message_at, created_at, updated_at,
        worktree_path, worktree_branch, worktree_base_branch, worktree_workspace_id,
        parent_id, kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of tickets) {
      insertTicket.run(
        row.id, row.title, row.type, row.source_kind, row.source_ref, row.stage, row.status, row.current_task,
        row.message, messageAt(row.id), row.created_at, ticketUpdatedAt(row.id),
        row.worktree_path, row.worktree_branch, row.worktree_base_branch, row.worktree_workspace_id,
        row.parent_id, row.kind,
      );
    }

    const insertTask = db.prepare(`
      INSERT INTO tasks (
        ticket_id, task_id, status, review_round, review_verdict,
        review_finding_count, review_blocking_count, review_updated_at, updated_at,
        artifact, source_ref, verification_profile, evidence_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBlockedBy = db.prepare(
      "INSERT INTO task_blocked_by (ticket_id, task_id, blocked_by_task_id) VALUES (?, ?, ?)",
    );
    for (const row of tasks) {
      const reviewAt = reviewUpdatedAt(row.ticket_id, row.task_id);
      insertTask.run(
        row.ticket_id, row.task_id, row.status,
        reviewAt ? row.review_round : null,
        reviewAt ? row.review_verdict : null,
        reviewAt ? row.review_finding_count : null,
        reviewAt ? row.review_blocking_count : null,
        reviewAt,
        taskUpdatedAt(row.ticket_id, row.task_id),
        row.artifact, null, row.verification_profile, row.evidence_path,
      );
      for (const dep of row.blockedBy) {
        insertBlockedBy.run(row.ticket_id, row.task_id, dep);
      }
    }

    const insertBlocker = db.prepare(
      "INSERT INTO blockers (ticket_id, reason, since, owner, task) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of blockers) {
      insertBlocker.run(row.ticket_id, row.reason, row.since, row.owner, row.task);
    }

    const insertDepend = db.prepare(
      "INSERT INTO ticket_depends (ticket_id, depends_on_ticket_id) VALUES (?, ?)",
    );
    for (const row of ticketDepends) {
      insertDepend.run(row.ticket_id, row.depends_on_ticket_id);
    }

    const insertSession = db.prepare(`
      INSERT INTO sessions (
        ticket_id, session_id, stage, task, round, model, pane_id, pane_name,
        session_file, status, context_tokens, context_window, context_percent,
        started_at, updated_at, subagent_id
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
    `);
    for (const row of sessions) {
      insertSession.run(
        row.ticket_id, row.session_id, row.stage, row.task, row.round,
        row.pane_id, row.pane_name, sessionFile(row.session_id), row.status,
        row.started_at, sessionUpdatedAt(row.session_id), row.subagent_id,
      );
    }

    const insertUsage = db.prepare(`
      INSERT INTO usage (
        ticket_id, session_id, stage, task, round, model, through_entry_id,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_total,
        cost_usd, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of usage) {
      insertUsage.run(
        row.ticket_id, row.session_id, row.stage, row.task, row.round, row.model, row.through_entry_id,
        row.tokens_input, row.tokens_output, row.tokens_cache_read, row.tokens_cache_write, row.tokens_total,
        row.cost_usd, row.recorded_at,
      );
    }

    const insertEvent = db.prepare(
      "INSERT INTO events (revision, at, op, ticket_id, task_id, payload) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertHook = db.prepare(`
      INSERT INTO hook_runs (
        revision, ticket_id, task_id, phase, event, command, exit_code,
        duration_ms, artifact, output, at
      ) VALUES (?, ?, ?, 'before', ?, ?, 0, ?, NULL, '', ?)
    `);
    events.forEach((event, index) => {
      const revision = index + 1;
      insertEvent.run(revision, event.at, event.op, event.ticket, event.task, JSON.stringify(event.payload));
      if (event.hook) {
        insertHook.run(revision, event.ticket, event.task, event.hook, HOOK, 40 + (index % 50), event.at);
      }
    });

    const updatedAt = events.at(-1).at;
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run("4");
    db.prepare("UPDATE meta SET value = ? WHERE key = 'storageVersion'").run("1");
    db.prepare("UPDATE meta SET value = ? WHERE key = 'revision'").run(String(events.length));
    db.prepare("UPDATE meta SET value = ? WHERE key = 'updatedAt'").run(updatedAt);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  }
  return { revision: events.length, tickets: tickets.map((row) => row.id) };
}

function task(ticketId, taskId, status, extra = {}) {
  const review = extra.review ?? [null, null, null, null];
  return {
    ticket_id: ticketId,
    task_id: taskId,
    status,
    artifact: extra.artifact ?? null,
    verification_profile: extra.profile ?? null,
    evidence_path: extra.evidence ?? null,
    review_round: review[0],
    review_verdict: review[1],
    review_finding_count: review[2],
    review_blocking_count: review[3],
    blockedBy: extra.blockedBy ?? [],
  };
}

function sess(ticket, id, stage, taskId, round, status, started, subagent, pane, paneName) {
  return {
    ticket_id: ticket,
    session_id: id,
    stage,
    task: taskId,
    round,
    status,
    started_at: started,
    subagent_id: subagent,
    pane_id: pane,
    pane_name: paneName,
  };
}

function use(ticket, id, stage, taskId, round, model, entry, input, output, cacheRead, cacheWrite, cost, at) {
  return {
    ticket_id: ticket,
    session_id: id,
    stage,
    task: taskId,
    round,
    model,
    through_entry_id: entry,
    tokens_input: input,
    tokens_output: output,
    tokens_cache_read: cacheRead,
    tokens_cache_write: cacheWrite,
    tokens_total: input + output + cacheRead + cacheWrite,
    cost_usd: cost,
    recorded_at: at,
  };
}

function ev(at, op, ticket, taskId, payload, hook = null) {
  return { at, op, ticket, task: taskId, payload, hook };
}

function ticketUpdatedAt(ticketId) {
  return events.filter((event) => event.ticket === ticketId).at(-1).at;
}

function messageAt(ticketId) {
  return [...events].reverse().find((event) => event.ticket === ticketId && event.op === "message").at;
}

function taskUpdatedAt(ticketId, taskId) {
  return [...events].reverse().find(
    (event) => event.ticket === ticketId && event.task === taskId && TASK_TOUCH.has(event.op),
  ).at;
}

function reviewUpdatedAt(ticketId, taskId) {
  return [...events].reverse().find(
    (event) => event.ticket === ticketId && event.task === taskId && event.op === "review_record",
  )?.at ?? null;
}

function sessionUpdatedAt(sessionId) {
  return [...events].reverse().find(
    (event) => event.op === "session_record" && event.payload.session === sessionId,
  ).at;
}

function expectedTaskStatus(ticketId, taskId) {
  const transitions = events.filter(
    (event) => event.ticket === ticketId && event.task === taskId && event.op === "task_transition",
  );
  if (transitions.length === 0) {
    return "pending";
  }
  return transitions.at(-1).payload.status;
}

function expectedCurrentTask(ticketId) {
  const transitions = events.filter((event) => event.ticket === ticketId && event.op === "task_transition");
  if (transitions.length === 0) {
    return null;
  }
  return transitions.at(-1).payload.currentTask;
}

function expectedStageStatus(ticketId) {
  const created = events.find((event) => event.ticket === ticketId && event.op === "create");
  let stage = created.payload.stage;
  let status = created.payload.status;
  for (const event of events) {
    if (event.ticket !== ticketId) {
      continue;
    }
    if (event.op === "transition") {
      stage = event.payload.stage;
      status = event.payload.status;
    } else if (event.op === "block") {
      status = event.payload.status;
    }
  }
  return { stage, status };
}
