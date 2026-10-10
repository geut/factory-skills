#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
PACKET = SCRIPTS / "review-packet.py"

PLAN = """# Document init Context generation

## Outcome
packages/chan/README.md documents slice 13's implemented behavior.

## Constraints
Keep the README under the existing heading structure.

## Test seams
Grep-based anchor check against the README.

## Task map
- 01: Document init Context generation
- 02: Follow-up examples

## Discoveries
The artifacts intro already mentions ADR-0001.
"""

TASK = """# Document init Context generation

Status: ready_for_review
Type: feature
Blocked by: none

## User story
As a chan user, I want the README to explain Context generation.

## Scope
Document init Context generation. No code change.

## Acceptance criteria
- [x] The chan init section documents Context generation
- [x] Every TOC link target exists

## Verification
Grep-based anchor check.
"""

AC_LINE = "The chan init section documents Context generation"
OUTCOME_LINE = "packages/chan/README.md documents slice 13's implemented behavior."
CONSTRAINT_LINE = "Keep the README under the existing heading structure."


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(PACKET), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        check=check,
    )


def init_repo(root: Path) -> Path:
    work = root / "work"
    work.mkdir()
    git(work, "init")
    git(work, "config", "user.email", "test@example.com")
    git(work, "config", "user.name", "Test")
    git(work, "config", "commit.gpgsign", "false")
    (work / "readme.md").write_text("hello\n")
    git(work, "add", "readme.md")
    git(work, "commit", "-m", "init")
    (work / "readme.md").write_text("hello world\n")
    (work / "notes.md").write_text("untracked notes\n")
    return work


def write_factory(root: Path, extra_task: str | None = None) -> Path:
    factory = root / "factory"
    ticket = factory / "tickets" / "PROJ-14"
    ticket.mkdir(parents=True)
    (ticket / "plan.md").write_text(PLAN)
    (ticket / "01-task-docs.md").write_text(TASK)
    if extra_task is not None:
        (ticket / extra_task).write_text(TASK)
    return factory


def packet_paths(out: Path) -> tuple[Path, Path]:
    return out / "PROJ-14-T01-R1-packet.md", out / "PROJ-14-T01-R1.diff"


class ReviewPacketTests(unittest.TestCase):
    def test_happy_path_writes_intent_and_cumulative_diff(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work = init_repo(root)
            factory = write_factory(root)
            out = root / "out"
            result = run_cli(
                "--ticket",
                "PROJ-14",
                "--task",
                "01",
                "--worktree",
                str(work),
                "--factory-root",
                str(factory),
                "--out",
                str(out),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            packet_path, diff_path = packet_paths(out)
            packet_path = packet_path.resolve()
            diff_path = diff_path.resolve()
            self.assertIn(f"packet: {packet_path}", result.stdout)
            self.assertIn(f"diff: {diff_path}", result.stdout)
            self.assertTrue(packet_path.is_file())
            self.assertTrue(diff_path.is_file())

            packet = packet_path.read_text()
            self.assertIn(AC_LINE, packet)
            self.assertIn(OUTCOME_LINE, packet)
            self.assertIn(CONSTRAINT_LINE, packet)
            self.assertIn("As a chan user, I want the README to explain Context generation.", packet)
            self.assertIn("- 01: Document init Context generation", packet)
            self.assertNotIn("- 02: Follow-up examples", packet)
            self.assertNotIn("R1-01", packet)
            self.assertNotIn("## Verdict", packet)
            self.assertNotIn("`npm test`: passed", packet)
            self.assertNotIn("## E2E", packet)
            self.assertIn("readme.md", packet)
            self.assertIn("### Untracked", packet)
            self.assertIn("- notes.md", packet)

            diff = diff_path.read_text()
            self.assertIn("hello world", diff)
            self.assertIn("notes.md", diff)
            self.assertIn("untracked notes", diff)

    def test_task_one_finds_zero_padded_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work = init_repo(root)
            factory = write_factory(root)
            out = root / "out"
            result = run_cli(
                "--ticket",
                "PROJ-14",
                "--task",
                "1",
                "--worktree",
                str(work),
                "--factory-root",
                str(factory),
                "--out",
                str(out),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((out / "PROJ-14-T1-R1-packet.md").is_file())

    def test_invalid_base_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work = init_repo(root)
            factory = write_factory(root)
            out = root / "out"
            out.mkdir()
            result = run_cli(
                "--ticket",
                "PROJ-14",
                "--task",
                "01",
                "--worktree",
                str(work),
                "--factory-root",
                str(factory),
                "--base",
                "not-a-ref",
                "--out",
                str(out),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid base", result.stderr)
            self.assertEqual(list(out.iterdir()), [])

    def test_ambiguous_task_file_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work = init_repo(root)
            factory = write_factory(root, extra_task="01-task-other.md")
            out = root / "out"
            out.mkdir()
            result = run_cli(
                "--ticket",
                "PROJ-14",
                "--task",
                "01",
                "--worktree",
                str(work),
                "--factory-root",
                str(factory),
                "--out",
                str(out),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("ambiguous task file", result.stderr)
            self.assertEqual(list(out.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
