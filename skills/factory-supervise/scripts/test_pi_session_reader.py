#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
READER = SCRIPTS / "pi-session-reader.py"
FIXTURES = SCRIPTS / "fixtures"


def _load_reader():
    spec = importlib.util.spec_from_file_location("pi_session_reader", READER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {READER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pi_session_reader = _load_reader()


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(READER), *args],
        capture_output=True,
        text=True,
        check=False,
    )


class RecapAfterContractTests(unittest.TestCase):
    path = FIXTURES / "recap-after-contract.jsonl"

    def test_last_message_skips_trailing_tool_only_turn(self) -> None:
        result = run_cli("last-message", str(self.path))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("The factory.plan.v3 contract in my previous message", result.stdout)
        self.assertNotIn("## Status", result.stdout)

    def test_contract_finds_template_before_recap(self) -> None:
        result = run_cli("contract", "--schema", "factory.plan.v3", str(self.path))
        self.assertEqual(result.returncode, 0, result.stderr)
        obj = json.loads(result.stdout)
        self.assertEqual(obj["status"], "planned")
        self.assertEqual(obj["readyTasks"], ["01"])
        self.assertEqual(obj["plan"], ".factory/tickets/PROJ-14/plan.md")

    def test_check_prints_one_line(self) -> None:
        result = run_cli("contract", "--schema", "factory.plan.v3", "--check", str(self.path))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ok factory.plan.v3 status=planned ready=01")

    def test_usage_sums_pi_totals_including_tool_only_turn(self) -> None:
        result = run_cli("usage", str(self.path))
        self.assertEqual(result.returncode, 0, result.stderr)
        obj = json.loads(result.stdout)
        self.assertEqual(obj["sessionId"], "sess-plan-1")
        self.assertEqual(obj["throughEntryId"], "a3")
        self.assertEqual(obj["model"], "opencode-go/glm-5.3")
        self.assertEqual(
            obj["tokens"],
            {
                "input": 171,
                "output": 1016,
                "cacheRead": 53924,
                "cacheWrite": 5,
                "total": 55116,
            },
        )
        self.assertAlmostEqual(obj["costUsd"], 0.01876204)


class ToolResultExampleTests(unittest.TestCase):
    path = FIXTURES / "toolresult-example.jsonl"

    def test_contract_ignores_skill_example_in_tool_result(self) -> None:
        result = run_cli("contract", "--schema", "factory.review.v4", str(self.path))
        self.assertEqual(result.returncode, 0, result.stderr)
        obj = json.loads(result.stdout)
        self.assertEqual(obj["verdict"], "approve")
        self.assertEqual(obj["findings"], [])
        self.assertNotEqual(obj["summary"], "This is the skill example, not a real verdict.")

    def test_last_message_is_prose_recap(self) -> None:
        result = run_cli("last-message", str(self.path))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Verdict: **approve**", result.stdout)
        self.assertNotIn("## Findings", result.stdout)


class ForkTests(unittest.TestCase):
    path = FIXTURES / "fork.jsonl"

    def test_discarded_fork_is_not_counted(self) -> None:
        result = run_cli("usage", str(self.path))
        self.assertEqual(result.returncode, 0, result.stderr)
        obj = json.loads(result.stdout)
        self.assertEqual(obj["sessionId"], "sess-fork-1")
        self.assertEqual(obj["throughEntryId"], "c1")
        self.assertEqual(
            obj["tokens"],
            {
                "input": 41,
                "output": 62,
                "cacheRead": 303,
                "cacheWrite": 14,
                "total": 420,
            },
        )
        self.assertAlmostEqual(obj["costUsd"], 0.40)
        self.assertNotIn(999, obj["tokens"].values())

    def test_contract_uses_active_branch_not_discarded_fork(self) -> None:
        result = run_cli("contract", "--schema", "factory.work.v3", str(self.path))
        self.assertEqual(result.returncode, 0, result.stderr)
        obj = json.loads(result.stdout)
        self.assertEqual(obj["status"], "ready_for_review")
        self.assertIsNone(obj["blocker"])
        self.assertEqual(obj["tests"][0]["command"], "npm test")

    def test_compaction_usage_is_included(self) -> None:
        entries = pi_session_reader.load_entries(self.path)
        session, branch = pi_session_reader.active_branch(entries)
        self.assertEqual(session["id"], "sess-fork-1")
        self.assertEqual([entry.get("id") for entry in branch], ["m1", "a-root", "a-active", "c1"])
        self.assertNotIn("a-discarded", [entry.get("id") for entry in branch])
        record = pi_session_reader.usage_record(session, branch)
        self.assertEqual(record["tokens"]["total"], 420)


class ValidationAndErrorsTests(unittest.TestCase):
    def test_unknown_schema_exits_2(self) -> None:
        result = run_cli("contract", "--schema", "factory.future.v1", str(FIXTURES / "fork.jsonl"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("unknown schema", result.stderr)

    def test_missing_review_contract_exits_3(self) -> None:
        path = FIXTURES / "recap-after-contract.jsonl"
        result = run_cli("contract", "--schema", "factory.review.v4", str(path))
        self.assertEqual(result.returncode, 3)
        self.assertIn("no factory.review.v4", result.stderr)

    def test_invalid_review_contract_exits_4(self) -> None:
        path = FIXTURES / "invalid-review.jsonl"
        result = run_cli("contract", "--schema", "factory.review.v4", str(path))
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn("invalid factory.review.v4", result.stderr)
        self.assertIn("verdict", result.stderr)

    def test_missing_file_exits_1(self) -> None:
        result = run_cli("usage", str(FIXTURES / "missing.jsonl"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot read", result.stderr)

    def test_missing_schema_flag_exits_2(self) -> None:
        result = run_cli("contract", str(FIXTURES / "fork.jsonl"))
        self.assertEqual(result.returncode, 2)


class ReviewFindingsTests(unittest.TestCase):
    def test_numbered_finding_ids_and_blocking(self) -> None:
        text = """
## Verdict
changes_requested

## Summary
AC-1 is unmet.

## Findings

### 1. [major] Filter is not restored
**Location:** src/filter.ts:12
**Finding:** Saved value is ignored on the next visit.
**Evidence:** tests/filter.test.ts does not cover restoration.
**Suggestion:** Restore the persisted value on init.
"""
        obj = pi_session_reader.parse_review(text, 2)
        self.assertEqual(obj["verdict"], "changes_requested")
        self.assertEqual(obj["findings"][0]["id"], "R2-01")
        self.assertTrue(obj["findings"][0]["blocking"])
        self.assertEqual(obj["blockingCount"], 1)

    def test_approve_with_none_findings(self) -> None:
        text = "## Verdict\napprove\n\n## Summary\nReady.\n\n## Findings\nnone\n"
        obj = pi_session_reader.parse_review(text, 1)
        self.assertEqual(obj["findingCount"], 0)
        self.assertEqual(
            pi_session_reader.check_line(obj),
            "ok factory.review.v4 verdict=approve findings=0 blocking=0",
        )


class WrapupTests(unittest.TestCase):
    path = FIXTURES / "wrapup.jsonl"

    def test_wrapup_headings(self) -> None:
        result = run_cli("contract", "--schema", "factory.wrapup.v1", "--check", str(self.path))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ok factory.wrapup.v1 headings=7")


if __name__ == "__main__":
    unittest.main()
