import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blank, run, session } from '../../stories/fixtures.ts';
import { latestPassRun, passBaselineText, rebasedRefusal } from './rebased.ts';

// A ticket at wrap-up, waiting on its agent's question, whose session has an
// earlier round's finished pass.
function waiting() {
  const snapshot = blank();
  snapshot.execution.stage = 'wrapup';
  snapshot.execution.status = 'waiting_for_user';
  const wrapup = session(snapshot, 'wrapup');
  const earlier = run(snapshot, wrapup);
  earlier.baseline = '{"head":"first"}';
  return { earlier, snapshot, wrapup };
}

test('the pass is the runs from its latest baseline: a round that only asked has no run to validate', () => {
  const { earlier, snapshot, wrapup } = waiting();
  assert.equal(latestPassRun(snapshot), earlier);
  // A feedback round's pass starts in the same session, and its first run asks.
  const asked = run(snapshot, wrapup, { terminal: 'caller_ping' });
  asked.baseline = '{"head":"round"}';
  assert.equal(passBaselineText(snapshot), '{"head":"round"}');
  assert.equal(latestPassRun(snapshot), null);
  assert.match(
    rebasedRefusal(snapshot) ?? '',
    /wrap-up pass has no finished run to validate; reply to the agent instead\./,
  );
  // Once the round's pass finishes a run, that run is the one.
  const finished = run(snapshot, wrapup);
  assert.equal(latestPassRun(snapshot), finished);
  assert.equal(rebasedRefusal(snapshot), null);
});
