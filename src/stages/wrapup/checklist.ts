import type { ReviewFinding, TicketRecord } from '../../domain.ts';
import { issueCheckboxes, type Checkbox } from '../../ports/checklist.ts';

// What wrap-up concluded about the issue: the boxes it met, the boxes left
// open and why, and the decisions that changed the issue's approach.
export type IssueChecklist = {
  decisions: Array<string>;
  met: Array<Checkbox>;
  open: Array<Checkbox & { reason: string }>;
};

// What the checklist is checked against: the issue's open boxes, each task's
// acceptance criterion ids and those its review verified or QA's test plan
// covers, the findings its latest review left open, and whether a cited file
// exists in the worktree.
export type ChecklistContext = {
  boxes: Array<Checkbox>;
  criteria: Map<string, Array<string>>;
  exists: (file: string) => boolean;
  findings: Array<{ finding: ReviewFinding; taskId: string }>;
  proven: Map<string, Array<string>>;
};

// The open boxes of the ticket's issue. A ticket from a file or --text has no
// issue to tick.
export function openBoxes(ticket: TicketRecord): Array<Checkbox> {
  return ticket.sourceKind === 'file' || ticket.sourceKind === 'text'
    ? []
    : issueCheckboxes(ticket.body);
}

// `01`, `1`, and `001` name the same task.
const sameTask = (left: string, right: string) =>
  left.replace(/^0+(?=.)/, '') === right.replace(/^0+(?=.)/, '');

const isNone = (text: string) => /^none\.?$/i.test(text.trim());

// Whether `criterion` of `taskId` is listed in `byTask`.
function listed(byTask: Map<string, Array<string>>, taskId: string, criterion: string): boolean {
  return [...byTask].some(
    ([task, criteria]) => sameTask(task, taskId) && criteria.includes(criterion),
  );
}

// The `Task <id> AC<n>` criteria an evidence text cites.
function criterionCitations(evidence: string): Array<{ criterion: string; taskId: string }> {
  return [...evidence.matchAll(/\bTask\s+(\w+)\s+AC\s*0*(\d+)\b/gi)].map((match) => ({
    criterion: `AC${match[2] ?? ''}`,
    taskId: match[1] ?? '',
  }));
}

// The path-like words of an evidence text, without a `:line` suffix.
function fileCitations(evidence: string): Array<string> {
  return evidence
    .split(/[\s,;()[\]`'"]+/)
    .map((word) => word.replace(/(?::\d+(?:-\d+)?)?[.:]*$/, ''))
    .filter((word) => word.includes('/') || /\.[A-Za-z0-9]+$/.test(word));
}

// Whether a finding's text names `criterion`, such as AC2 or AC 2.
function namesCriterion(finding: ReviewFinding, criterion: string): boolean {
  const number = criterion.slice(2);
  return new RegExp(`\\bAC\\s*0*${number}\\b`, 'i').test(
    [finding.title, finding.finding, finding.evidence, finding.location, finding.suggestion].join(
      '\n',
    ),
  );
}

// Reads `## Issue checklist` (`- B1: met — evidence` or `- B2: not_met —
// reason`, one line per open box, or `none` when the issue has none) and
// `## Decisions` (`none` or bullet points). A met box must cite a task
// criterion review verified or QA tested, or a worktree file, and no open
// review finding may name a criterion it cites.
export function checkIssueChecklist(
  checklist: string,
  decisions: string,
  context: ChecklistContext,
): { failures: Array<string>; result: IssueChecklist } {
  const failures: Array<string> = [];
  const result: IssueChecklist = { decisions: [], met: [], open: [] };
  const seen = new Set<string>();
  for (const raw of isNone(checklist) ? [] : checklist.trim().split('\n')) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const match = /^(?:[-*]\s+)?B0*(\d+)\s*:\s*([a-z_]+)\s*(?:(?:—|–|--|-)\s*(.*))?$/i.exec(
      line.replaceAll('`', '').replaceAll(/\*\*([^*]+)\*\*/g, '$1'),
    );
    if (match === null) {
      failures.push(
        `Issue checklist line "${line}" must look like "- B1: met — evidence" or "- B2: not_met — reason".`,
      );
      continue;
    }
    const id = `B${match[1] ?? ''}`;
    const status = (match[2] ?? '').toLowerCase();
    const evidence = (match[3] ?? '').trim();
    const box = context.boxes.find((item) => item.id === id);
    if (box === undefined) {
      failures.push(
        `${id} is not an open box of the issue (${context.boxes.map((item) => item.id).join(', ') || 'none'}).`,
      );
      continue;
    }
    if (seen.has(id)) {
      failures.push(`${id} appears twice in ## Issue checklist.`);
      continue;
    }
    seen.add(id);
    if (status === 'not_met') {
      if (evidence.length === 0) {
        failures.push(`${id} is not_met without a reason; say why it is not met.`);
      }
      result.open.push({ ...box, reason: evidence });
      continue;
    }
    if (status !== 'met') {
      failures.push(`${id} has status "${status}"; use met or not_met.`);
      continue;
    }
    const cited = criterionCitations(evidence);
    const known = cited.filter((item) => listed(context.criteria, item.taskId, item.criterion));
    const proven = known.filter((item) => listed(context.proven, item.taskId, item.criterion));
    for (const { criterion, taskId } of cited) {
      if (!known.some((item) => item.taskId === taskId && item.criterion === criterion)) {
        failures.push(
          `${id} cites Task ${taskId} ${criterion}, which is not a criterion of this ticket's tasks.`,
        );
      } else if (!proven.some((item) => item.taskId === taskId && item.criterion === criterion)) {
        failures.push(
          `${id} cites Task ${taskId} ${criterion}, which review did not verify and QA's test plan does not cover.`,
        );
      }
    }
    if (proven.length === 0 && !fileCitations(evidence).some(context.exists)) {
      failures.push(
        `${id} is met but cites no verified task criterion (Task 01 AC1) or file that exists in the worktree.`,
      );
    }
    for (const { criterion, taskId } of known) {
      const open = context.findings.find(
        (item) => sameTask(item.taskId, taskId) && namesCriterion(item.finding, criterion),
      );
      if (open !== undefined) {
        failures.push(
          `${id} is met, but open finding Task ${open.taskId} ${open.finding.id} names ${criterion}; mark ${id} not_met with that finding as the reason.`,
        );
      }
    }
    result.met.push(box);
  }
  for (const box of context.boxes.filter((item) => !seen.has(item.id))) {
    failures.push(`## Issue checklist has no line for ${box.id}.`);
  }
  result.decisions = parseDecisions(decisions);
  if (!isNone(decisions) && result.decisions.length === 0) {
    failures.push('## Decisions must be none or bullet points.');
  }
  return { failures, result };
}

// The bullet points of `## Decisions`; a wrapped bullet goes on.
function parseDecisions(section: string): Array<string> {
  const decisions: Array<string> = [];
  for (const line of isNone(section) ? [] : section.split('\n')) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      decisions.push((bullet[1] ?? '').trim());
    } else if (decisions.length > 0 && line.trim().length > 0) {
      decisions[decisions.length - 1] += ` ${line.trim()}`;
    }
  }
  return decisions;
}
