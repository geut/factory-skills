#!/usr/bin/env node
/**
 * Hard lifecycle gate. Reads a factory lifecycle envelope on stdin.
 *
 * task:ready_for_review requires .factory/evidence/<ticket>/<task>/manifest.json
 * with at least one criterion whose exitCode is 0.
 *
 * ticket:wrapup requires every concrete task to be done and to have that manifest.
 * Umbrella tickets coordinate related tickets and do not need task manifests.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readEnvelope() {
  const raw = readFileSync(0, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`invalid lifecycle envelope: ${err.message}`);
  }
  return null;
}

function manifestPath(envelope, taskId) {
  return path.join(envelope.factoryRoot, "evidence", envelope.ticket, taskId, "manifest.json");
}

function checkManifest(file) {
  if (!existsSync(file)) {
    fail(`missing evidence manifest: ${file}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`invalid evidence manifest ${file}: ${err.message}`);
  }
  if (!Array.isArray(parsed.criteria) || parsed.criteria.length === 0) {
    fail(`evidence manifest has no criteria: ${file}`);
  }
  for (const criterion of parsed.criteria) {
    if (!criterion || criterion.exitCode !== 0 || typeof criterion.command !== "string" || !criterion.command) {
      fail(`criterion ${criterion?.id || "(missing id)"} is not proven in ${file}`);
    }
  }
}

const envelope = readEnvelope();
if (!envelope?.factoryRoot || !envelope?.ticket || !envelope?.event) {
  fail("lifecycle envelope requires factoryRoot, ticket, and event");
}

if (envelope.event === "task:ready_for_review") {
  if (!envelope.task) {
    fail("task:ready_for_review requires a task id");
  }
  checkManifest(manifestPath(envelope, envelope.task));
  process.exit(0);
}

if (envelope.event === "ticket:wrapup") {
  if (envelope.kind === "umbrella") {
    process.exit(0);
  }
  const tasks = Array.isArray(envelope.tasks) ? envelope.tasks : [];
  if (tasks.length === 0) {
    fail(`ticket ${envelope.ticket} has no tasks to wrap up`);
  }
  for (const task of tasks) {
    if (task.status !== "done") {
      fail(`task ${task.id} is ${task.status}, not done`);
    }
    checkManifest(manifestPath(envelope, task.id));
  }
  process.exit(0);
}

process.exit(0);
