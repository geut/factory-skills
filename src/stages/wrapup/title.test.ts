import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isTitleTemplate,
  renderTitle,
  type TicketOrigin,
  titleExample,
  titleMatches,
  titleTemplateProblem,
  type TitleTemplate,
} from './title.ts';

const github: TicketOrigin = { displayRef: 'geut/factory-skills#42', sourceKind: 'github' };
const linear: TicketOrigin = { displayRef: 'ENG-42', sourceKind: 'linear' };
const text: TicketOrigin = { displayRef: 'local-1', sourceKind: 'text' };
const file: TicketOrigin = { displayRef: 'notes/ticket.md', sourceKind: 'file' };

function template(value: string): TitleTemplate {
  if (!isTitleTemplate(value)) {
    throw new Error(`${value}: ${titleTemplateProblem(value) ?? ''}`);
  }
  return value;
}

function example(value: string | null, ticket: TicketOrigin): string {
  return titleExample(renderTitle({ template: value === null ? null : template(value), ticket }));
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

test('an empty ref drops the separator next to it', () => {
  assert.equal(example('{ref} | {summary}', text), '<summary>');
  assert.equal(example('{ref}: {summary}', file), '<summary>');
  assert.equal(example('[{ref}] {summary}', text), '<summary>');
  assert.equal(example('{summary} ({ref})', text), '<summary>');
  assert.equal(example('{summary} - {ref}', text), '<summary>');
  assert.equal(example('feat({ref}): {summary}', text), 'feat: <summary>');
  assert.equal(example('feat: {ref} | {summary}', text), 'feat: <summary>');
});

test('a template needs {summary} once and only known placeholders', () => {
  assert.equal(titleTemplateProblem('{ref} | {summary}'), null);
  assert.match(titleTemplateProblem('{ref}') ?? '', /\{summary\} once/);
  assert.match(titleTemplateProblem('{summary} {summary}') ?? '', /\{summary\} once/);
  assert.match(titleTemplateProblem('{key}: {summary}') ?? '', /\{key\} is not a placeholder/);
});

test('a title matches when only the summary differs and the summary is not empty', () => {
  const title = renderTitle({ template: template('{ref} | {summary}'), ticket: linear });
  assert.equal(titleMatches(title, 'ENG-42 | Persist the filter'), true);
  assert.equal(titleMatches(title, 'ENG-42: Persist the filter'), false);
  assert.equal(titleMatches(title, 'Persist the filter'), false);
  assert.equal(titleMatches(title, 'ENG-42 | '), false);
  const bare = renderTitle({ template: null, ticket: github });
  assert.equal(titleMatches(bare, 'Persist the filter'), true);
  assert.equal(titleMatches(bare, ''), false);
});
