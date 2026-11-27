import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validationSummary } from './ticket-access.ts';

const passed = { checks: [], passed: true };

test('a requested validation says why a pass will not be reused', () => {
  assert.match(
    validationSummary({ ...passed, attached: true, reusable: true }),
    /^Validation passed\. If you change nothing more/,
  );
  // A changed or unreadable input does not claim that files changed.
  assert.match(
    validationSummary({ ...passed, attached: true, reusable: false }),
    /cannot be reused: files changed while the commands ran, or git could not read the inputs/,
  );
  assert.match(
    validationSummary({ ...passed, attached: false, reusable: true }),
    /your run ended before the result came back/,
  );
  assert.match(
    validationSummary({ attached: true, checks: [], passed: false, reusable: false }),
    /^Validation failed\./,
  );
});
