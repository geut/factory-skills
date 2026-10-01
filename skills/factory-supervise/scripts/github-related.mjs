#!/usr/bin/env node
/**
 * Discover concrete related issues for a parent.
 *
 * Official sub-issues win when `gh` returns them. Otherwise parse a structured
 * body: a `## Parent` section and a `## Blocked by` section that mention `#<n>`.
 *
 * --issues-file <json> reads [{number, title, body}] for tests.
 * Otherwise pass --issue <n> and optional --repo <owner/name>.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const PARENT_RE = /^##\s+parent\s*$/im;
const BLOCKED_RE = /^##\s+blocked by\s*$/im;
const ISSUE_RE = /#(\d+)/g;

function section(body, headingRe) {
  const match = headingRe.exec(body);
  if (!match) {
    return "";
  }
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const next = rest.search(/^##\s+/m);
  return next === -1 ? rest : rest.slice(0, next);
}

export function parseIssueBody(body) {
  const text = String(body || "");
  const parentSection = section(text, PARENT_RE);
  const blockedSection = section(text, BLOCKED_RE);
  const parentMatch = parentSection.match(/#(\d+)/);
  const blockedBy = [];
  for (const match of blockedSection.matchAll(ISSUE_RE)) {
    const number = Number(match[1]);
    if (!blockedBy.includes(number)) {
      blockedBy.push(number);
    }
  }
  return {
    parent: parentMatch ? Number(parentMatch[1]) : null,
    blockedBy,
  };
}

export function relatedTickets(issues, rootNumber) {
  const byNumber = new Map(issues.map((issue) => [Number(issue.number), issue]));
  const root = byNumber.get(Number(rootNumber));
  if (!root) {
    throw new Error(`issue #${rootNumber} not found`);
  }
  const children = [];
  for (const issue of issues) {
    if (Number(issue.number) === Number(rootNumber)) {
      continue;
    }
    const parsed = parseIssueBody(issue.body);
    if (parsed.parent === Number(rootNumber)) {
      children.push({
        number: Number(issue.number),
        title: issue.title || "",
        url: issue.url || null,
        blockedBy: parsed.blockedBy,
        body: issue.body || "",
      });
    }
  }
  children.sort((a, b) => a.number - b.number);
  return {
    number: Number(rootNumber),
    title: root.title || "",
    kind: children.length > 0 ? "umbrella" : "concrete",
    children,
  };
}

function ghJson(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "gh failed").trim());
  }
  return JSON.parse(result.stdout);
}

function loadFromGh(issue, repo) {
  const repoArgs = repo ? ["--repo", repo] : [];
  const root = ghJson([
    "issue",
    "view",
    String(issue),
    ...repoArgs,
    "--json",
    "number,title,body,url",
  ]);
  let sub = [];
  if (repo) {
    const subResult = spawnSync("gh", ["api", `repos/${repo}/issues/${issue}/sub_issues`], {
      encoding: "utf8",
    });
    if (subResult.status === 0 && subResult.stdout.trim()) {
      try {
        const parsed = JSON.parse(subResult.stdout);
        if (Array.isArray(parsed) && parsed.length > 0) {
          sub = parsed.map((item) => ({
            number: item.number,
            title: item.title || "",
            body: item.body || "",
            url: item.html_url || null,
          }));
        }
      } catch {
        sub = [];
      }
    }
  }
  if (sub.length > 0) {
    return {
      number: root.number,
      title: root.title || "",
      kind: "umbrella",
      children: sub
        .map((issueRow) => {
          const parsed = parseIssueBody(issueRow.body);
          return { ...issueRow, blockedBy: parsed.blockedBy };
        })
        .sort((a, b) => a.number - b.number),
    };
  }
  const listed = ghJson([
    "issue",
    "list",
    ...repoArgs,
    "--state",
    "all",
    "--limit",
    "200",
    "--json",
    "number,title,body,url",
  ]);
  return relatedTickets([root, ...listed], issue);
}

function main() {
  const { values } = parseArgs({
    options: {
      issue: { type: "string" },
      repo: { type: "string" },
      "issues-file": { type: "string" },
    },
  });
  let graph;
  if (values["issues-file"]) {
    const issues = JSON.parse(readFileSync(values["issues-file"], "utf8"));
    graph = relatedTickets(issues, values.issue);
  } else if (values.issue) {
    graph = loadFromGh(values.issue, values.repo);
  } else {
    throw new Error("--issue is required");
  }
  process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("github-related.mjs")) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
