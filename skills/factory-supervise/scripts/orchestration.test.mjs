import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { parseIssueBody, relatedTickets } from "./github-related.mjs";
import { renderVerificationSkill } from "./write-verification-skill.mjs";

const roots = [];

afterEach(async () => {
  while (roots.length) {
    await rm(roots.pop(), { recursive: true, force: true });
  }
});

test("related issues become concrete tickets and a parent stays an umbrella", () => {
  const parsed = parseIssueBody("## Parent\n#1\n\n## Blocked by\n#2 and #4\n");
  assert.equal(parsed.parent, 1);
  assert.deepEqual(parsed.blockedBy, [2, 4]);

  const graph = relatedTickets(
    [
      { number: 1, title: "Parent", body: "Coordinate the slices." },
      { number: 3, title: "Unrelated", body: "## Parent\n#9\n" },
      {
        number: 2,
        title: "First slice",
        url: "https://example.test/2",
        body: "## Parent\n#1\n\n## Blocked by\nnone\n",
      },
      {
        number: 4,
        title: "Second slice",
        body: "## Parent\n#1\n\n## Blocked by\n#2\n",
      },
    ],
    1,
  );
  assert.equal(graph.kind, "umbrella");
  assert.deepEqual(
    graph.children.map((child) => child.number),
    [2, 4],
  );
  assert.deepEqual(graph.children[1].blockedBy, [2]);
  assert.equal(relatedTickets([{ number: 8, title: "Solo", body: "" }], 8).kind, "concrete");
});

test("verification skill names Launch, Drive, Evidence, and Surf for a web app", async () => {
  const code = await mkdtemp(path.join(tmpdir(), "verify-code-"));
  const factory = await mkdtemp(path.join(tmpdir(), "verify-factory-"));
  roots.push(code, factory);
  await writeFile(
    path.join(code, "package.json"),
    `${JSON.stringify({ scripts: { dev: "vite" } })}\n`,
  );
  await writeFile(path.join(code, "pnpm-lock.yaml"), "");
  const rendered = renderVerificationSkill({ codeRoot: code, factoryRoot: factory, repo: "demo" });
  const skill = rendered.files["SKILL.md"];
  assert.equal(rendered.web, true);
  assert.match(skill, /## Launch/);
  assert.match(skill, /## Doctor/);
  assert.match(skill, /## Drive/);
  assert.match(skill, /## Evidence/);
  assert.match(skill, /## Cleanup/);
  assert.match(skill, /pnpm dev/);
  assert.match(skill, /SURF_SESSION/);
  assert.match(skill, /session\.ensure/);
  assert.match(skill, /wait\.ready/);
  assert.match(skill, /--auto-capture/);
  assert.match(skill, /network\.stats/);
  assert.match(rendered.files["features/primary.md"], /Do not treat a green typecheck/);
});

test("factory agents auto-exit and specialist skills require subagent_done", async () => {
  const root = path.resolve(import.meta.dirname, "..", "..", "..");
  for (const role of ["factory-plan", "factory-work", "factory-review", "factory-wrapup"]) {
    const agent = await readFile(path.join(import.meta.dirname, "..", "agents", `${role}.md`), "utf8");
    assert.match(agent, /auto-exit:\s*true/);
    assert.match(agent, /subagent_done/);
    const skill = await readFile(path.join(root, "skills", role, "SKILL.md"), "utf8");
    assert.match(skill, /subagent_done/);
  }
  const done = await readFile(path.join(import.meta.dirname, "fixtures", "handshake-done.jsonl"), "utf8");
  const missing = await readFile(path.join(import.meta.dirname, "fixtures", "handshake-missing.jsonl"), "utf8");
  assert.match(done, /"id":"01a0f557-20a5-7440-a0a0-a30ae8e3d9e2"/);
  assert.match(done, /"name":"subagent_done"/);
  assert.doesNotMatch(missing, /subagent_done/);
  const prove = await readFile(path.join(root, "skills", "prove-it-works", "SKILL.md"), "utf8");
  assert.match(prove, /manifest\.json/);
});
