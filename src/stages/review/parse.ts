import type { ReviewFinding, ReviewResult, ReviewSeverity, ReviewVerdict } from '../../domain.ts';

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

// Parses the factory.review.v4 Markdown template. The verdict drives a
// transition, so a result that breaks the verdict rules is malformed.
export function parseReview(output: string, round: number): ParsedReview {
  const markdown = unfence(output);
  const failures: Array<string> = [];
  const verdictSection = section(markdown, 'Verdict');
  const summary = section(markdown, 'Summary');
  const findingsSection = section(markdown, 'Findings');
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
  if (failures.length > 0 || verdict === null || summary === null) {
    return { failures, kind: 'invalid' };
  }
  return { kind: 'valid', result: { findings, round, summary, verdict } };
}

export function formatFinding(finding: ReviewFinding): string {
  const location = finding.location === null ? '' : ` (${finding.location})`;
  const outcome = finding.suggestion === null ? '' : ` Outcome needed: ${finding.suggestion}`;
  return `${finding.id} [${finding.severity}] ${finding.title}${location}: ${finding.finding} Evidence: ${finding.evidence}${outcome}`;
}
