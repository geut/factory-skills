import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ticketId, type ResolvedTicket, type TicketId } from './domain.ts';
import { sha256 } from './hash.ts';
import type { IssueLink, Tracker, TrackerIssue } from './ports/tracker.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type TicketSource =
  | { kind: 'ref'; value: string }
  | { body: string; id: string; kind: 'text' };

// `reason` marks failures that are not a bad reference: an issue with
// sub-issues, or a tracker that could not be reached.
export type ResolveResult =
  | { kind: 'ticket'; ticket: ResolvedTicket }
  | { kind: 'error'; message: string; reason?: 'tracker_unavailable' | 'umbrella_issue' };

function slug(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 48) : 'ticket';
}

function factoryDir(factoryRoot: string, displayRef: string, canonical: string): string {
  return path.join(factoryRoot, 'tickets', `${slug(displayRef)}-${sha256(canonical).slice(0, 8)}`);
}

function trackedTicket(
  kind: string,
  issue: TrackerIssue,
  fetchedAt: string,
  factoryRoot: string,
): ResolvedTicket {
  const id = ticketId(issue.id);
  return {
    body: issue.body,
    commandRef: issue.ref,
    contentHash: sha256(`${issue.title}\n${issue.body}\n${issue.labels.join('\n')}`),
    displayRef: issue.displayRef,
    factoryDir: factoryDir(factoryRoot, issue.displayRef, id),
    fetchedAt,
    id,
    labels: issue.labels,
    sourceKind: kind,
    sourceRef: issue.url.length > 0 ? issue.url : issue.displayRef,
    title: issue.title,
  };
}

function localTicket(input: {
  body: string;
  codeRoot: string;
  commandRef: string;
  factoryRoot: string;
  fetchedAt: string;
  id: string;
  sourceKind: 'file' | 'text';
  sourceRef: string;
  title: string;
}): ResolvedTicket {
  const repo = path.basename(input.codeRoot).replaceAll(/[^\w.-]+/g, '-');
  const id = ticketId(`local:${repo}:${input.id}`);
  return {
    body: input.body,
    commandRef: input.commandRef,
    contentHash: sha256(`${input.title}\n${input.body}`),
    displayRef: input.id,
    factoryDir: factoryDir(input.factoryRoot, input.id, id),
    fetchedAt: input.fetchedAt,
    id,
    labels: [],
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
  factoryRoot: string;
  fetchedAt: string;
  source: TicketSource;
  // Resolves every ref that is not a local file.
  tracker: Tracker;
}): ResolveResult {
  if (input.source.kind === 'text') {
    return {
      kind: 'ticket',
      ticket: localTicket({
        body: input.source.body,
        codeRoot: input.codeRoot,
        commandRef: input.source.id,
        factoryRoot: input.factoryRoot,
        fetchedAt: input.fetchedAt,
        id: input.source.id,
        sourceKind: 'text',
        sourceRef: `text:${input.source.id}`,
        title: titleFromBody(input.source.body, input.source.id),
      }),
    };
  }

  const ref = input.source.value.trim();
  const filePath = path.resolve(input.codeRoot, ref);
  if (existsSync(filePath) && (filePath.endsWith('.md') || filePath.endsWith('.json'))) {
    const text = readFileSync(filePath, 'utf8');
    if (filePath.endsWith('.json')) {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed) || typeof parsed['id'] !== 'string') {
        return { kind: 'error', message: `${filePath} needs a string id.` };
      }
      const body = typeof parsed['body'] === 'string' ? parsed['body'] : text;
      const title = typeof parsed['title'] === 'string' ? parsed['title'] : parsed['id'];
      return {
        kind: 'ticket',
        ticket: localTicket({
          body,
          codeRoot: input.codeRoot,
          commandRef: ref,
          factoryRoot: input.factoryRoot,
          fetchedAt: input.fetchedAt,
          id: parsed['id'],
          sourceKind: 'file',
          sourceRef: filePath,
          title,
        }),
      };
    }
    const stem = path.basename(filePath, '.md');
    return {
      kind: 'ticket',
      ticket: localTicket({
        body: text,
        codeRoot: input.codeRoot,
        commandRef: ref,
        factoryRoot: input.factoryRoot,
        fetchedAt: input.fetchedAt,
        id: stem,
        sourceKind: 'file',
        sourceRef: filePath,
        title: titleFromBody(text, stem),
      }),
    };
  }

  const resolved = input.tracker.resolve(ref);
  if (resolved === null) {
    return {
      kind: 'error',
      message: `Cannot resolve ${ref}. Use a GitHub URL, owner/repo#number, #number, or a local markdown/json ticket.`,
    };
  }
  if (resolved.kind === 'error') {
    return resolved;
  }
  const { issue } = resolved;
  let children: Array<IssueLink>;
  try {
    children = input.tracker.children(issue);
  } catch (error: unknown) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : 'The tracker failed.',
      reason: 'tracker_unavailable',
    };
  }
  if (children.length > 0) {
    const names = children.map((child) => `${child.displayRef} ${child.title}`).join(', ');
    return {
      kind: 'error',
      message: `${issue.displayRef} is an umbrella issue. Start each concrete issue separately: ${names}.`,
      reason: 'umbrella_issue',
    };
  }
  return {
    kind: 'ticket',
    ticket: trackedTicket(input.tracker.kind, issue, input.fetchedAt, input.factoryRoot),
  };
}

export function sameTicket(
  left: string,
  ticket: { commandRef: string; displayRef: string; id: TicketId; sourceRef: string },
): boolean {
  return (
    left === ticket.id ||
    left === ticket.displayRef ||
    left === ticket.commandRef ||
    left === ticket.sourceRef
  );
}
