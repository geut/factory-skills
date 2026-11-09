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
  if (template !== template.trim()) {
    return 'It must not start or end with spaces, because GitHub trims titles.';
  }
  // A title is one line; GitHub would not store a newline as written.
  if (/\p{Cc}/u.test(template)) {
    return 'It must not contain newlines or other control characters.';
  }
  const names = [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
  const unknown = names.find((name) => !PLACEHOLDERS.has(name));
  if (unknown !== undefined) {
    return `{${unknown}} is not a placeholder; use {ref} and {summary}.`;
  }
  if (/[{}]/.test(template.replaceAll(PLACEHOLDER, ''))) {
    return 'Braces may only wrap {ref} and {summary}.';
  }
  const summaries = names.filter((name) => name === 'summary').length;
  return summaries === 1 ? null : 'It must contain {summary} once.';
}

export function isTitleTemplate(template: string): template is TitleTemplate {
  return titleTemplateProblem(template) === null;
}

// For a template that is known to be valid, such as a default or a test's.
export function parseTitleTemplate(template: string): TitleTemplate {
  if (!isTitleTemplate(template)) {
    throw new Error(`${template} is not a title template: ${titleTemplateProblem(template) ?? ''}`);
  }
  return template;
}

// GitHub links a pull request to an issue of its own repository without the
// ref in the title; another tracker needs its key there.
const GITHUB_DEFAULT = parseTitleTemplate('{summary}');
const TRACKER_DEFAULT = parseTitleTemplate('{ref}: {summary}');

// Where a ticket came from, as the ticket records it.
export type TicketOrigin = { displayRef: string; sourceKind: string };

// The ticket as its tracker names it: `#42` for an issue of the code host's
// repository, `owner/repo#42` for one of another, the issue key such as
// `ENG-42` for any other tracker, and nothing for a local ticket.
export function ticketRef(input: { codeHostRepo: string | null; ticket: TicketOrigin }): string {
  const { displayRef, sourceKind } = input.ticket;
  switch (sourceKind) {
    case 'file':
    case 'text':
      return '';
    case 'github': {
      const match = /^(.+)(#\d+)$/.exec(displayRef);
      const sameRepo =
        match?.[1] !== undefined &&
        input.codeHostRepo !== null &&
        match[1].toLowerCase() === input.codeHostRepo.toLowerCase();
      return sameRepo && match[2] !== undefined ? match[2] : displayRef;
    }
    default:
      return displayRef;
  }
}

// Letters, digits, and placeholder braces are content; anything else between
// them is a separator. Brackets wrap a ref, so they go with it.
const SEPARATOR = String.raw`[^\p{L}\p{N}{}()[\]<>]*`;
const EMPTY_REF = new RegExp(
  `(${SEPARATOR})(\\(\\{ref\\}\\)|\\[\\{ref\\}\\]|<\\{ref\\}>|\\{ref\\})(${SEPARATOR})`,
  'gu',
);

const hasPunctuation = (separator: string) => separator.trim().length > 0;

// An empty ref takes its brackets and one separator with it: the one toward
// the rest of the title at either end, and none when it is attached to a
// word, as in `feat({ref}): {summary}`. In the middle the separator that
// stays is the one with punctuation, so `Fix {ref}: {summary}` keeps its
// colon, and the one before it when both have some.
function dropRef(template: string): string {
  return template.replaceAll(
    EMPTY_REF,
    (whole: string, before: string, _ref: string, after: string, offset: number) => {
      if (offset === 0 || offset + whole.length === template.length) {
        return '';
      }
      if (before.length === 0 || after.length === 0) {
        return before + after;
      }
      return hasPunctuation(before) || !hasPunctuation(after) ? before : after;
    },
  );
}

// A rendered title: wrap-up's summary goes between the prefix and the suffix.
export type PullRequestTitle = { prefix: string; suffix: string };

export function renderTitle(input: {
  codeHostRepo: string | null;
  template: TitleTemplate | null;
  ticket: TicketOrigin;
}): PullRequestTitle {
  const ref = ticketRef(input);
  const template =
    input.template ?? (input.ticket.sourceKind === 'github' ? GITHUB_DEFAULT : TRACKER_DEFAULT);
  // A function, so a `$` in the ref is not read as a replacement pattern.
  const filled = ref === '' ? dropRef(template) : template.replaceAll('{ref}', () => ref);
  const at = filled.indexOf('{summary}');
  return { prefix: filled.slice(0, at), suffix: filled.slice(at + '{summary}'.length) };
}

// A ticket's title from the settings saved when it started. The prompt and
// the validator both use this, so the agent is checked against the title it
// was told.
export function ticketTitle(snapshot: {
  execution: { policy: { codeHostRepo: string | null; pullRequestTitle: TitleTemplate | null } };
  ticket: TicketOrigin;
}): PullRequestTitle {
  return renderTitle({
    codeHostRepo: snapshot.execution.policy.codeHostRepo,
    template: snapshot.execution.policy.pullRequestTitle,
    ticket: snapshot.ticket,
  });
}

// The title as the agent is told to write it, with `<summary>` to replace.
export function titleExample(title: PullRequestTitle): string {
  return `${title.prefix}<summary>${title.suffix}`;
}

// Whether `actual` is the rendered title with a non-empty summary. GitHub
// trims titles, so the comparison does too.
export function titleMatches(title: PullRequestTitle, actual: string): boolean {
  const prefix = title.prefix.trimStart();
  const suffix = title.suffix.trimEnd();
  const trimmed = actual.trim();
  if (
    trimmed.length < prefix.length + suffix.length ||
    !trimmed.startsWith(prefix) ||
    !trimmed.endsWith(suffix)
  ) {
    return false;
  }
  return trimmed.slice(prefix.length, trimmed.length - suffix.length).trim().length > 0;
}
