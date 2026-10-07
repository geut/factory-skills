import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIssueBody, relatedTickets } from "./tickets.ts";

test("related issues become concrete tickets and a parent stays an umbrella", () => {
  const parsed = parseIssueBody("## Parent\n#1\n\n## Blocked by\n#2 and #4\n");
  assert.equal(parsed.parent, 1);
  assert.deepEqual(parsed.blockedBy, [2, 4]);
  const graph = relatedTickets(
    [
      { body: "Coordinate the slices.", number: 1, title: "Parent", url: null },
      { body: "## Parent\n#9\n", number: 3, title: "Unrelated", url: null },
      { body: "## Parent\n#1\n\n## Blocked by\nnone\n", number: 2, title: "First slice", url: "https://example.test/2" },
      { body: "## Parent\n#1\n\n## Blocked by\n#2\n", number: 4, title: "Second slice", url: null },
    ],
    1,
  );
  assert.equal(graph.kind, "umbrella");
  if (graph.kind !== "umbrella") {return;}
  assert.deepEqual(
    graph.children.map((child) => child.number),
    [2, 4],
  );
  assert.equal(relatedTickets([{ body: "", number: 8, title: "Solo", url: null }], 8).kind, "concrete");
});
