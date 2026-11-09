import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseTitleTemplate,
  renderTitle,
  type TicketOrigin,
  titleExample,
  titleMatches,
  titleTemplateProblem,
} from './title.ts';

const github: TicketOrigin = { displayRef: 'geut/factory-skills#42', sourceKind: 'github' };
const linear: TicketOrigin = { displayRef: 'ENG-42', sourceKind: 'linear' };
const text: TicketOrigin = { displayRef: 'local-1', sourceKind: 'text' };
const file: TicketOrigin = { displayRef: 'notes/ticket.md', sourceKind: 'file' };
const codeHostRepo = 'geut/factory-skills';

function example(
  value: string | null,
  ticket: TicketOrigin,
  repo: string | null = codeHostRepo,
): string {
  return titleExample(
    renderTitle({
      codeHostRepo: repo,
      template: value === null ? null : parseTitleTemplate(value),
      ticket,
    }),
  );
}

test('without a template, a GitHub ticket is titled by its summary and another tracker adds its key', () => {
  assert.equal(example(null, github), '<summary>');
  assert.equal(example(null, linear), 'ENG-42: <summary>');
  assert.equal(example(null, text), '<summary>');
  assert.equal(example(null, file), '<summary>');
});

test('a template names the ticket as its tracker does', () => {
  assert.equal(example('{ref} | {summary}', linear), 'ENG-42 | <summary>');
  assert.equal(example('{ref} | {summary}', github), '#42 | <summary>');
  assert.equal(example('[{ref}] {summary}', linear), '[ENG-42] <summary>');
  assert.equal(example('feat: {summary} ({ref})', linear), 'feat: <summary> (ENG-42)');
});

test('a GitHub issue of another repository keeps its owner and repo', () => {
  assert.equal(
    example('{ref} | {summary}', github, 'geut/other'),
    'geut/factory-skills#42 | <summary>',
  );
  assert.equal(example('{ref} | {summary}', github, 'GEUT/Factory-Skills'), '#42 | <summary>');
  assert.equal(example('{ref} | {summary}', github, null), 'geut/factory-skills#42 | <summary>');
});

test('an empty ref drops the separator next to it', () => {
  assert.equal(example('{ref} | {summary}', text), '<summary>');
  assert.equal(example('{ref}: {summary}', file), '<summary>');
  assert.equal(example('[{ref}] {summary}', text), '<summary>');
  assert.equal(example('{summary} ({ref})', text), '<summary>');
  assert.equal(example('{summary} - {ref}', text), '<summary>');
  assert.equal(example('feat({ref}): {summary}', text), 'feat: <summary>');
  assert.equal(example('feat: {ref} | {summary}', text), 'feat: <summary>');
  // In the middle, the separator with punctuation stays.
  assert.equal(example('Fix {ref}: {summary}', text), 'Fix: <summary>');
  assert.equal(example('feat [{ref}]: {summary}', text), 'feat: <summary>');
});

test('a template needs {summary} once, only known placeholders, and no stray braces or edge spaces', () => {
  assert.equal(titleTemplateProblem('{ref} | {summary}'), null);
  assert.match(titleTemplateProblem('{ref}') ?? '', /\{summary\} once/);
  assert.match(titleTemplateProblem('{summary} {summary}') ?? '', /\{summary\} once/);
  assert.match(titleTemplateProblem('{key}: {summary}') ?? '', /\{key\} is not a placeholder/);
  assert.match(titleTemplateProblem('{summary} {{ref}}') ?? '', /Braces may only wrap/);
  assert.match(titleTemplateProblem('{summary} }') ?? '', /Braces may only wrap/);
  assert.match(titleTemplateProblem('{ref} | {summary} ') ?? '', /GitHub trims titles/);
});

test('a title matches when only the summary differs and the summary is not empty', () => {
  const title = renderTitle({
    codeHostRepo,
    template: parseTitleTemplate('{ref} | {summary}'),
    ticket: linear,
  });
  assert.equal(titleMatches(title, 'ENG-42 | Persist the filter'), true);
  assert.equal(titleMatches(title, '  ENG-42 | Persist the filter '), true);
  assert.equal(titleMatches(title, 'ENG-42: Persist the filter'), false);
  assert.equal(titleMatches(title, 'Persist the filter'), false);
  assert.equal(titleMatches(title, 'ENG-42 | '), false);
  const bare = renderTitle({ codeHostRepo, template: null, ticket: github });
  assert.equal(titleMatches(bare, 'Persist the filter'), true);
  assert.equal(titleMatches(bare, ''), false);
});
