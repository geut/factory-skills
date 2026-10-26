import type {
  FactorySnapshot,
  ReviewFinding,
  RunRecord,
  ReviewResult,
  ReviewSeverity,
  ReviewVerdict,
  ReviewVerification,
  VerificationStatus,
} from '../../domain.ts';
import { runOutput } from '../output.ts';

export const REVIEW_CONTRACT = 'factory.review.v5';

// What a review is checked against: the task's acceptance criterion ids,
// the earlier blocking finding ids it must verify, and the worktree's files.
export type ReviewContext = {
  criteria: ReadonlyArray<string>;
  earlierFindings: ReadonlyArray<string>;
  // The file's line count, by worktree-relative path, or null when it is not there.
  lineCount: (file: string) => number | null;
};

export type ParsedReview =
  | { kind: 'valid'; result: ReviewResult }
  | { failures: Array<string>; kind: 'invalid' };

const verdicts: ReadonlyArray<ReviewVerdict> = ['approve', 'changes_requested', 'blocked'];
const severities: ReadonlyArray<ReviewSeverity> = ['critical', 'major', 'minor'];

function verdictOf(value: string): ReviewVerdict | null {
  return verdicts.find((item) => item === value) ?? null;
}

function severityOf(value: string): ReviewSeverity | null {
  return severities.find((item) => item === value) ?? null;
}

function unfence(output: string): string {
  const trimmed = output.trim();
  const fenced = /^```[\w-]*\n([\s\S]*)\n```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

function section(markdown: string, heading: string): string | null {
  const match = new RegExp(`^##\\s+${heading}\\s*$`, 'im').exec(markdown);
  if (match === null) {
    return null;
  }
  const rest = markdown.slice(match.index + match[0].length);
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function plain(value: string): string {
  return value.replaceAll(/[`*]/g, '').trim();
}

type FindingFields = Partial<Record<'evidence' | 'finding' | 'location' | 'suggestion', string>>;

function findingFields(body: string): FindingFields {
  const fields: FindingFields = {};
  let current: keyof FindingFields | null = null;
  for (const line of body.split('\n')) {
    const field = /^\*\*(Location|Finding|Evidence|Suggestion)(?::\*\*|\*\*:)\s*(.*)$/i.exec(
      line.trim(),
    );
    if (field !== null) {
      const name = field[1]?.toLowerCase();
      current =
        name === 'location' || name === 'finding' || name === 'evidence' || name === 'suggestion'
          ? name
          : null;
      if (current !== null) {
        fields[current] = field[2]?.trim() ?? '';
      }
      continue;
    }
    if (current !== null && line.trim().length > 0) {
      fields[current] = `${fields[current] ?? ''}\n${line.trim()}`.trim();
    }
  }
  return fields;
}

function parseFindings(body: string, round: number, failures: Array<string>): Array<ReviewFinding> {
  if (/^none\.?$/i.test(body.trim())) {
    return [];
  }
  const blocks = body.split(/^###\s+/m).slice(1);
  if (blocks.length === 0) {
    failures.push('## Findings must be `none` or numbered `### 1. [Severity] Title` findings.');
    return [];
  }
  const findings: Array<ReviewFinding> = [];
  const seen = new Set<number>();
  for (const block of blocks) {
    const [heading = '', ...lines] = block.split('\n');
    const header = /^(\d+)\.\s*\[([^\]]+)\]\s*(.+)$/.exec(heading.trim());
    if (header === null) {
      failures.push(
        `Finding heading "### ${heading.trim()}" must look like "### 1. [Major] Title".`,
      );
      continue;
    }
    const number = Number(header[1]);
    const label = `Finding ${number}`;
    if (seen.has(number)) {
      failures.push(`${label} is numbered twice.`);
      continue;
    }
    seen.add(number);
    const severity = severityOf(plain(header[2] ?? '').toLowerCase());
    if (severity === null) {
      failures.push(`${label} has severity "${header[2] ?? ''}"; use Critical, Major, or Minor.`);
      continue;
    }
    const fields = findingFields(lines.join('\n'));
    if (fields.finding === undefined || fields.finding.length === 0) {
      failures.push(`${label} is missing **Finding:**.`);
      continue;
    }
    if (fields.evidence === undefined || fields.evidence.length === 0) {
      failures.push(`${label} is missing **Evidence:**.`);
      continue;
    }
    findings.push({
      blocking: severity !== 'minor',
      evidence: fields.evidence,
      finding: fields.finding,
      id: `R${round}-${number}`,
      location:
        fields.location === undefined || fields.location.length === 0 ? null : fields.location,
      number,
      severity,
      suggestion:
        fields.suggestion === undefined || fields.suggestion.length === 0
          ? null
          : fields.suggestion,
      title: (header[3] ?? '').trim(),
    });
  }
  return findings;
}

// `AC01` and `ac1` are AC1; `R1-02` is R1-2, the id the controller gave it.
function verificationId(value: string): { id: string; kind: 'criterion' | 'finding' } | null {
  const criterion = /^AC0*(\d+)$/i.exec(value);
  if (criterion !== null) {
    return { id: `AC${Number(criterion[1])}`, kind: 'criterion' };
  }
  const finding = /^R0*(\d+)-0*(\d+)$/i.exec(value);
  return finding === null
    ? null
    : { id: `R${Number(finding[1])}-${Number(finding[2])}`, kind: 'finding' };
}

const statusesFor = {
  criterion: ['verified', 'not_verified'],
  finding: ['fixed', 'still_open'],
} as const satisfies Record<string, ReadonlyArray<VerificationStatus>>;

// The `path:line` and `path:start-end` locations an evidence text cites.
export function citations(
  evidence: string,
): Array<{ end: number; file: string; start: number; text: string }> {
  const found = [];
  for (const match of evidence.matchAll(
    /(?<![^\s([`"'])([^\s:`"'()[\]]*[./][^\s:`"'()[\]]*):(\d+)(?:-(\d+))?(?![\w-])/g,
  )) {
    const start = Number(match[2]);
    found.push({
      end: match[3] === undefined ? start : Number(match[3]),
      file: match[1] ?? '',
      start,
      text: match[0],
    });
  }
  return found;
}

// The `- <id>: <status> — <evidence>` lines of ## Verification. Without a
// context only their form is checked; with one, every expected id must appear
// and every cited location must exist.
function parseVerification(
  body: string,
  failures: Array<string>,
  context: ReviewContext | null,
): Array<ReviewVerification> {
  const lines: Array<ReviewVerification> = [];
  const text = body.trim();
  for (const raw of /^none\.?$/i.test(text) ? [] : text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const match = /^(?:[-*]\s+)?([\w-]+)\s*:\s*([a-z_]+)\s*(?:(?:—|–|--|-)\s*(.*))?$/i.exec(
      // Bold and code marks are dropped; a glob's `*` in the evidence stays.
      line.replaceAll('`', '').replaceAll(/\*\*([^*]+)\*\*/g, '$1'),
    );
    const id = match === null ? null : verificationId(match[1] ?? '');
    if (match === null || id === null) {
      failures.push(
        `Verification line "${line}" must look like "- AC1: verified — path:line" or "- R1-2: fixed — path:line".`,
      );
      continue;
    }
    const status = (match[2] ?? '').toLowerCase();
    const evidence = (match[3] ?? '').trim();
    const allowed: ReadonlyArray<string> = statusesFor[id.kind];
    if (!allowed.includes(status)) {
      failures.push(`${id.id} has status "${status}"; use ${allowed.join(' or ')}.`);
      continue;
    }
    if (lines.some((item) => item.id === id.id)) {
      failures.push(`${id.id} appears twice in ## Verification.`);
      continue;
    }
    if (status === 'not_verified' && evidence.length === 0) {
      failures.push(`${id.id} is not_verified without a reason; say why it could not be verified.`);
    }
    if (status === 'verified' || status === 'fixed') {
      const cited = citations(evidence);
      if (cited.length === 0) {
        failures.push(`${id.id} is ${status} but cites no path:line; cite the code that shows it.`);
      }
      for (const citation of context === null ? [] : cited) {
        const count = context?.lineCount(citation.file) ?? null;
        if (count === null) {
          failures.push(`${id.id} cites ${citation.text}, which does not exist in the worktree.`);
        } else if (citation.start < 1 || citation.end < citation.start || citation.end > count) {
          failures.push(
            `${id.id} cites ${citation.text}, but ${citation.file} has ${count} line${count === 1 ? '' : 's'}.`,
          );
        }
      }
    }
    lines.push({ evidence, id: id.id, status: status as VerificationStatus });
  }
  if (context !== null) {
    const expected = [...context.criteria, ...context.earlierFindings];
    for (const id of expected.filter((item) => !lines.some((line) => line.id === item))) {
      failures.push(`## Verification has no line for ${id}.`);
    }
    for (const line of lines.filter((item) => !expected.includes(item.id))) {
      failures.push(
        line.id.startsWith('AC')
          ? `${line.id} is not an acceptance criterion of this task (${context.criteria.join(', ') || 'none'}).`
          : `${line.id} is not an earlier blocking finding (${context.earlierFindings.join(', ') || 'none'}).`,
      );
    }
  }
  return lines;
}

// Parses the factory.review.v5 Markdown template, with its Verification lines
// checked against `context` when one is given. The verdict drives a
// transition, so a result that breaks the verdict rules is malformed.
export function parseReview(
  output: string,
  round: number,
  context: ReviewContext | null = null,
): ParsedReview {
  const markdown = unfence(output);
  const failures: Array<string> = [];
  const verdictSection = section(markdown, 'Verdict');
  const summary = section(markdown, 'Summary');
  const findingsSection = section(markdown, 'Findings');
  const verificationSection = section(markdown, 'Verification');
  let verdict: ReviewVerdict | null = null;
  if (verdictSection === null) {
    failures.push('## Verdict is missing.');
  } else {
    const value = plain(verdictSection.split('\n')[0] ?? '').toLowerCase();
    verdict = verdictOf(value);
    if (verdict === null) {
      failures.push(
        `## Verdict must be exactly one of approve, changes_requested, or blocked; got "${value}".`,
      );
    }
  }
  if (summary === null || summary.length === 0) {
    failures.push('## Summary is missing or empty.');
  }
  if (findingsSection === null) {
    failures.push('## Findings is missing.');
  }
  if (verificationSection === null) {
    failures.push(
      '## Verification is missing. Add it between Summary and Findings, with one line per acceptance criterion and earlier blocking finding.',
    );
  }
  const verification =
    verificationSection === null ? [] : parseVerification(verificationSection, failures, context);
  const findings = findingsSection === null ? [] : parseFindings(findingsSection, round, failures);
  const blocking = findings.filter((finding) => finding.blocking);
  if (verdict === 'approve' && blocking.length > 0) {
    failures.push(
      `approve cannot include a blocking finding: ${blocking.map((item) => item.id).join(', ')}.`,
    );
  }
  if (verdict === 'changes_requested' && blocking.length === 0) {
    failures.push('changes_requested needs at least one Critical or Major finding.');
  }
  const open = verification.filter((line) => line.status === 'still_open');
  if (verdict === 'approve' && open.length > 0) {
    failures.push(
      `approve cannot leave an earlier finding still_open: ${open.map((line) => line.id).join(', ')}.`,
    );
  }
  if (failures.length > 0 || verdict === null || summary === null) {
    return { failures, kind: 'invalid' };
  }
  return { kind: 'valid', result: { findings, round, summary, verdict, verification } };
}

// A finished review run's result.
export function runReview(run: RunRecord, output = runOutput(run)): ParsedReview {
  return parseReview(output, run.semanticRound);
}

// The blocking findings of the task's latest valid review before `round`,
// which the review of `round` verifies.
export function earlierFindings(
  snapshot: FactorySnapshot,
  taskId: string,
  round: number,
): Array<ReviewFinding> {
  const sessions = new Set(
    snapshot.sessions
      .filter((item) => item.stage === 'review' && item.taskId === taskId)
      .map((item) => item.id),
  );
  const earlier = snapshot.runs
    .filter(
      (run) =>
        sessions.has(run.sessionId) && run.resultStatus === 'valid' && run.semanticRound < round,
    )
    .sort(
      (left, right) => right.semanticRound - left.semanticRound || right.sequence - left.sequence,
    );
  for (const run of earlier) {
    const parsed = runReview(run);
    if (parsed.kind === 'valid') {
      return parsed.result.findings.filter((finding) => finding.blocking);
    }
  }
  return [];
}

// Each task's latest valid review result, in session order.
export function latestReviews(
  snapshot: FactorySnapshot,
): Array<{ result: ReviewResult; taskId: string }> {
  return snapshot.sessions.flatMap((session) => {
    if (session.stage !== 'review' || session.taskId === null) {
      return [];
    }
    const latest = snapshot.runs
      .filter((run) => run.sessionId === session.id && run.resultStatus === 'valid')
      .sort((left, right) => right.sequence - left.sequence)[0];
    const parsed = latest === undefined ? null : runReview(latest);
    return parsed?.kind === 'valid' ? [{ result: parsed.result, taskId: session.taskId }] : [];
  });
}

// How many acceptance criteria a review verified, and which it could not:
// `6/6 ACs verified` or `5/6 ACs verified · AC3 not verified`. Null for a
// review without criterion lines.
export function verificationSummary(result: ReviewResult): string | null {
  const criteria = result.verification.filter((line) => line.id.startsWith('AC'));
  if (criteria.length === 0) {
    return null;
  }
  const missed = criteria.filter((line) => line.status === 'not_verified').map((line) => line.id);
  const verified = `${criteria.length - missed.length}/${criteria.length} ACs verified`;
  return missed.length === 0 ? verified : `${verified} · ${missed.join(', ')} not verified`;
}

export function formatFinding(finding: ReviewFinding): string {
  const location = finding.location === null ? '' : ` (${finding.location})`;
  const outcome = finding.suggestion === null ? '' : ` Outcome needed: ${finding.suggestion}`;
  return `${finding.id} [${finding.severity}] ${finding.title}${location}: ${finding.finding} Evidence: ${finding.evidence}${outcome}`;
}
