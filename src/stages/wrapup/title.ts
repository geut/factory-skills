// The title of a ticket's pull request. The project sets it with
// `codeHost.pullRequestTitle`, a template with `{ref}` (the ticket as its
// tracker names it) and `{summary}` (wrap-up's one-line summary). The
// controller fills in `{ref}`; the agent writes the summary; the validator
// checks the rest of the title is the template's.

export type TitleTemplate = string & { readonly __brand: 'TitleTemplate' };

const PLACEHOLDER = /\{([^{}]*)\}/g;
const PLACEHOLDERS = new Set(['ref', 'summary']);

// Why `template` cannot be a title template, or null when it can.
export function titleTemplateProblem(template: string): string | null {
  const names = [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
  const unknown = names.find((name) => !PLACEHOLDERS.has(name));
  if (unknown !== undefined) {
    return `{${unknown}} is not a placeholder; use {ref} and {summary}.`;
  }
  const summaries = names.filter((name) => name === 'summary').length;
  return summaries === 1 ? null : 'It must contain {summary} once.';
}

export function isTitleTemplate(template: string): template is TitleTemplate {
  return titleTemplateProblem(template) === null;
}

// Where a ticket came from, as the ticket records it.
export type TicketOrigin = { displayRef: string; sourceKind: string };

// The ticket as its tracker names it: `#42` for a GitHub issue, the issue key
// such as `ENG-42` for any other tracker, and nothing for a local ticket.
export function ticketRef(ticket: TicketOrigin): string {
  switch (ticket.sourceKind) {
    case 'file':
    case 'text':
      return '';
    case 'github':
      return /#\d+$/.exec(ticket.displayRef)?.[0] ?? ticket.displayRef;
    default:
      return ticket.displayRef;
  }
}

// GitHub links a pull request to its issue without the ref in the title;
// another tracker needs its key there.
function defaultTemplate(sourceKind: string): TitleTemplate {
  const template = sourceKind === 'github' ? '{summary}' : '{ref}: {summary}';
  if (!isTitleTemplate(template)) {
    throw new Error(`The default title template ${template} is invalid.`);
  }
  return template;
}

// Letters, digits, and placeholder braces are content; anything else between
// them is a separator. Brackets wrap a ref, so they go with it.
const SEPARATOR = String.raw`[^\p{L}\p{N}{}()[\]<>]*`;
const EMPTY_REF = new RegExp(
  `(${SEPARATOR})(\\(\\{ref\\}\\)|\\[\\{ref\\}\\]|<\\{ref\\}>|\\{ref\\})(${SEPARATOR})`,
  'gu',
);

// An empty ref takes its brackets and one separator with it: the one toward
// the rest of the title at either end, the one after it in the middle, and
// none when it is attached to a word, as in `feat({ref}): {summary}`.
function dropRef(template: string): string {
  return template.replaceAll(
    EMPTY_REF,
    (whole: string, before: string, _ref: string, after: string, offset: number) => {
      const atStart = offset === 0;
      const atEnd = offset + whole.length === template.length;
      if (atStart || atEnd) {
        return '';
      }
      return before.length > 0 && after.length > 0 ? before : before + after;
    },
  );
}

// A rendered title: wrap-up's summary goes between the prefix and the suffix.
export type PullRequestTitle = { prefix: string; suffix: string };

export function renderTitle(input: {
  template: TitleTemplate | null;
  ticket: TicketOrigin;
}): PullRequestTitle {
  const ref = ticketRef(input.ticket);
  const template = input.template ?? defaultTemplate(input.ticket.sourceKind);
  const filled = ref === '' ? dropRef(template) : template.replaceAll('{ref}', ref);
  const at = filled.indexOf('{summary}');
  return { prefix: filled.slice(0, at), suffix: filled.slice(at + '{summary}'.length) };
}

// The title as the agent is told to write it, with `<summary>` to replace.
export function titleExample(title: PullRequestTitle): string {
  return `${title.prefix}<summary>${title.suffix}`;
}

// Whether `actual` is the rendered title with a non-empty summary.
export function titleMatches(title: PullRequestTitle, actual: string): boolean {
  if (!actual.startsWith(title.prefix) || !actual.endsWith(title.suffix)) {
    return false;
  }
  const summary = actual.slice(title.prefix.length, actual.length - title.suffix.length);
  return actual.length >= title.prefix.length + title.suffix.length && summary.trim().length > 0;
}
