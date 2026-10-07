import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FactoryConfig } from "./config.ts";
import { ticketId, type ResolvedTicket, type TicketId } from "./domain.ts";
import { sha256 } from "./hash.ts";

export type RelatedIssue = {
  body: string;
  number: number;
  title: string;
  url: string | null;
};

export type IssueGraph =
  | { kind: "concrete"; number: number; title: string }
  | { children: Array<RelatedIssue>; kind: "umbrella"; number: number; title: string; };

const PARENT_RE = /^##\s+parent\s*$/im;
const BLOCKED_RE = /^##\s+blocked by\s*$/im;
const ISSUE_RE = /#(\d+)/g;

function section(body: string, headingRe: RegExp): string {
  const match = headingRe.exec(body);
  if (!match) {return "";}
  const rest = body.slice(match.index + match[0].length);
  const next = rest.search(/^##\s+/m);
  return next === -1 ? rest : rest.slice(0, next);
}

export function parseIssueBody(body: string): { blockedBy: Array<number>; parent: number | null; } {
  const parentSection = section(body, PARENT_RE);
  const blockedSection = section(body, BLOCKED_RE);
  const parentMatch = parentSection.match(/#(\d+)/);
  const blockedBy: Array<number> = [];
  for (const match of blockedSection.matchAll(ISSUE_RE)) {
    const number = Number(match[1]);
    if (!blockedBy.includes(number)) {blockedBy.push(number);}
  }
  return { blockedBy, parent: parentMatch?.[1] === undefined ? null : Number(parentMatch[1]) };
}

export function relatedTickets(issues: Array<RelatedIssue>, rootNumber: number): IssueGraph {
  const root = issues.find((issue) => issue.number === rootNumber);
  if (root === undefined) {throw new Error(`issue #${rootNumber} not found`);}
  const children = issues
    .filter((issue) => issue.number !== rootNumber && parseIssueBody(issue.body).parent === rootNumber)
    .map((issue) => ({ ...issue, blockedBy: parseIssueBody(issue.body).blockedBy }))
    .sort((left, right) => left.number - right.number);
  if (children.length === 0) {return { kind: "concrete", number: rootNumber, title: root.title };}
  return { children, kind: "umbrella", number: rootNumber, title: root.title };
}

export type GithubIssue = {
  body: string;
  host: string;
  nodeId: string;
  number: number;
  owner: string;
  repo: string;
  title: string;
  url: string;
};

export type GithubClient = {
  fetchIssue: (input: { host: string; number: number; owner: string; repo: string; }) => GithubIssue;
  listSubIssues: (input: { number: number; owner: string; repo: string; }) => Array<RelatedIssue>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ghJson(args: Array<string>): unknown {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "gh failed").trim());
  }
  const parsed: unknown = JSON.parse(result.stdout);
  return parsed;
}

export function githubCliClient(): GithubClient {
  return {
    fetchIssue(input) {
      const payload = ghJson([
        "issue",
        "view",
        String(input.number),
        "--repo",
        `${input.owner}/${input.repo}`,
        "--json",
        "id,number,title,body,url",
      ]);
      if (!isRecord(payload) || typeof payload["id"] !== "string" || typeof payload["number"] !== "number") {
        throw new Error(`GitHub issue ${input.owner}/${input.repo}#${input.number} did not return an id.`);
      }
      return {
        body: typeof payload["body"] === "string" ? payload["body"] : "",
        host: input.host,
        nodeId: payload["id"],
        number: payload["number"],
        owner: input.owner,
        repo: input.repo,
        title: typeof payload["title"] === "string" ? payload["title"] : `Issue ${payload["number"]}`,
        url: typeof payload["url"] === "string" ? payload["url"] : "",
      };
    },
    listSubIssues(input) {
      const result = spawnSync(
        "gh",
        ["api", `repos/${input.owner}/${input.repo}/issues/${input.number}/sub_issues`],
        { encoding: "utf8" },
      );
      if (result.status !== 0 || result.stdout.trim().length === 0) {return [];}
      const parsed: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(parsed)) {return [];}
      const issues: Array<RelatedIssue> = [];
      for (const item of parsed) {
        if (!isRecord(item) || typeof item["number"] !== "number") {continue;}
        issues.push({
          body: typeof item["body"] === "string" ? item["body"] : "",
          number: item["number"],
          title: typeof item["title"] === "string" ? item["title"] : "",
          url: typeof item["html_url"] === "string" ? item["html_url"] : null,
        });
      }
      return issues;
    },
  };
}

export type TicketSource =
  | { kind: "ref"; value: string }
  | { body: string; id: string; kind: "text"; };

export type ResolveResult =
  | { kind: "ticket"; ticket: ResolvedTicket }
  | { kind: "error"; message: string };

type GithubTarget = { commandRef: string; host: string; number: number; owner: string; repo: string; };

function slug(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 48) : "ticket";
}

function factoryDir(factoryRoot: string, displayRef: string, canonical: string): string {
  return path.join(factoryRoot, "tickets", `${slug(displayRef)}-${sha256(canonical).slice(0, 8)}`);
}

function resolvedGithub(issue: GithubIssue, commandRef: string, fetchedAt: string, factoryRoot: string): ResolvedTicket {
  const id = ticketId(`github:${issue.host}:${issue.nodeId}`);
  const displayRef = `${issue.owner}/${issue.repo}#${issue.number}`;
  return {
    body: issue.body,
    commandRef,
    contentHash: sha256(`${issue.title}\n${issue.body}`),
    displayRef,
    factoryDir: factoryDir(factoryRoot, displayRef, id),
    fetchedAt,
    id,
    sourceKind: "github",
    sourceRef: issue.url.length > 0 ? issue.url : displayRef,
    title: issue.title,
  };
}

function githubTarget(ref: string, config: FactoryConfig): GithubTarget | { kind: "error"; message: string } | null {
  const url = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(ref);
  if (url?.[1] && url[2] && url[3] && url[4]) {
    return { commandRef: ref, host: url[1], number: Number(url[4]), owner: url[2], repo: url[3] };
  }
  const qualified = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(ref);
  if (qualified?.[1] && qualified[2] && qualified[3]) {
    return {
      commandRef: ref,
      host: config.github?.host ?? "github.com",
      number: Number(qualified[3]),
      owner: qualified[1],
      repo: qualified[2],
    };
  }
  const numbered = /^(?:#)?(\d+)$/.exec(ref);
  if (numbered?.[1]) {
    if (config.github === null) {
      return { kind: "error", message: `Bare issue ${ref} needs a single github owner and repo in FACTORY.json.` };
    }
    return {
      commandRef: ref,
      host: config.github.host,
      number: Number(numbered[1]),
      owner: config.github.owner,
      repo: config.github.repo,
    };
  }
  const key = /^([A-Za-z][A-Za-z0-9]+)-(\d+)$/.exec(ref);
  if (key?.[1] && key[2]) {
    const mapped = config.keys[key[1]];
    if (mapped === undefined && config.github === null) {return null;}
    if (mapped !== undefined && config.github === null) {
      return { kind: "error", message: `Key ${key[1]} maps to GitHub, but FACTORY.json has no github owner and repo.` };
    }
    if (mapped === undefined && Object.keys(config.keys).length > 0) {
      return { kind: "error", message: `No FACTORY.json key matches ${ref}.` };
    }
    if (config.github === null) {return null;}
    return {
      commandRef: ref,
      host: config.github.host,
      number: Number(key[2]),
      owner: config.github.owner,
      repo: config.github.repo,
    };
  }
  return null;
}

function localTicket(input: {
  body: string;
  codeRoot: string;
  commandRef: string;
  factoryRoot: string;
  fetchedAt: string;
  id: string;
  sourceKind: "file" | "text";
  sourceRef: string;
  title: string;
}): ResolvedTicket {
  const repo = path.basename(input.codeRoot).replaceAll(/[^\w.-]+/g, "-");
  const id = ticketId(`local:${repo}:${input.id}`);
  return {
    body: input.body,
    commandRef: input.commandRef,
    contentHash: sha256(`${input.title}\n${input.body}`),
    displayRef: input.id,
    factoryDir: factoryDir(input.factoryRoot, input.id, id),
    fetchedAt: input.fetchedAt,
    id,
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef,
    title: input.title,
  };
}

function titleFromBody(body: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(body);
  return match?.[1]?.trim() || fallback;
}

export function resolveTicket(input: {
  codeRoot: string;
  config: FactoryConfig;
  factoryRoot: string;
  fetchedAt: string;
  github: GithubClient;
  source: TicketSource;
}): ResolveResult {
  if (input.source.kind === "text") {
    return {
      kind: "ticket",
      ticket: localTicket({
        body: input.source.body,
        codeRoot: input.codeRoot,
        commandRef: input.source.id,
        factoryRoot: input.factoryRoot,
        fetchedAt: input.fetchedAt,
        id: input.source.id,
        sourceKind: "text",
        sourceRef: `text:${input.source.id}`,
        title: titleFromBody(input.source.body, input.source.id),
      }),
    };
  }

  const ref = input.source.value.trim();
  const filePath = path.resolve(input.codeRoot, ref);
  if (existsSync(filePath) && (filePath.endsWith(".md") || filePath.endsWith(".json"))) {
    const text = readFileSync(filePath, "utf8");
    if (filePath.endsWith(".json")) {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed) || typeof parsed["id"] !== "string") {
        return { kind: "error", message: `${filePath} needs a string id.` };
      }
      const body = typeof parsed["body"] === "string" ? parsed["body"] : text;
      const title = typeof parsed["title"] === "string" ? parsed["title"] : parsed["id"];
      return {
        kind: "ticket",
        ticket: localTicket({
          body,
          codeRoot: input.codeRoot,
          commandRef: ref,
          factoryRoot: input.factoryRoot,
          fetchedAt: input.fetchedAt,
          id: parsed["id"],
          sourceKind: "file",
          sourceRef: filePath,
          title,
        }),
      };
    }
    const stem = path.basename(filePath, ".md");
    return {
      kind: "ticket",
      ticket: localTicket({
        body: text,
        codeRoot: input.codeRoot,
        commandRef: ref,
        factoryRoot: input.factoryRoot,
        fetchedAt: input.fetchedAt,
        id: stem,
        sourceKind: "file",
        sourceRef: filePath,
        title: titleFromBody(text, stem),
      }),
    };
  }

  const target = githubTarget(ref, input.config);
  if (target === null) {
    return {
      kind: "error",
      message: `Cannot resolve ${ref}. Use a GitHub URL, owner/repo#number, a mapped KEY-number, or a local markdown/json ticket.`,
    };
  }
  if ("kind" in target) {return target;}

  let issue: GithubIssue;
  try {
    issue = input.github.fetchIssue(target);
  } catch (error: unknown) {
    const message =
      typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : "GitHub request failed";
    return { kind: "error", message };
  }
  const children = input.github.listSubIssues(target);
  if (children.length > 0) {
    const names = children.map((child) => `#${child.number} ${child.title}`).join(", ");
    return {
      kind: "error",
      message: `${issue.owner}/${issue.repo}#${issue.number} is an umbrella issue. Start each concrete issue separately: ${names}.`,
    };
  }
  return { kind: "ticket", ticket: resolvedGithub(issue, target.commandRef, input.fetchedAt, input.factoryRoot) };
}

export function sameTicket(left: string, ticket: { commandRef: string; displayRef: string; id: TicketId; sourceRef: string }): boolean {
  return left === ticket.id || left === ticket.displayRef || left === ticket.commandRef || left === ticket.sourceRef;
}
