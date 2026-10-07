import assert from "node:assert/strict";
import { test } from "node:test";
import { factoryStatusPayload, renderFactoryStatus, type StatusTheme } from "./status-message.ts";

const theme: StatusTheme = {
  fg: (_color, text) => text,
};

const notice = [
  "dpaez/factory-dashboard#7",
  "stage: plan",
  "status: active",
  "Run ended with subagent_done.",
  "Artifacts are written and validated: every ticket AC maps to task criteria.",
  "## Status",
  "planned",
  "## Artifacts",
  "- plan: .factory/tickets/example/plan.md",
].join("\n");

test("a factory status folds the template behind a one-line summary", () => {
  const collapsed = renderFactoryStatus({ expanded: false, text: notice, theme, width: 80 });
  assert.equal(collapsed[0], "dpaez/factory-dashboard#7 · plan · active");
  assert.match(collapsed[1] ?? "", /Artifacts are written and validated/);
  assert.doesNotMatch(collapsed.join("\n"), /## Status/);
  assert.match(collapsed.at(-1) ?? "", /\+\d+ lines · expand to read/);
  const expanded = renderFactoryStatus({ expanded: true, text: notice, theme, width: 80 });
  assert.match(expanded.join("\n"), /## Status/);
  assert.match(expanded.join("\n"), /plan\.md/);
  assert.doesNotMatch(expanded.join("\n"), /expand to read/);
  const payload = factoryStatusPayload(notice);
  assert.match(payload.content, /Artifacts are written and validated/);
  assert.doesNotMatch(payload.content, /## Status/);
  assert.equal(payload.details.text, notice);
});
