#!/usr/bin/env python3
"""Assemble a reviewer packet from plan/task intent and the ticket-worktree diff.

Intent is copied from the task file and related plan.md sections. Scope is the
cumulative uncommitted change in --worktree, including untracked files.

Do not restate the packet in the subagent prompt. Pass the two output paths.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

EXIT_OK = 0
EXIT_FAIL = 1

H2_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)

TASK_HEADINGS = (
    "User story",
    "Outcome",
    "Scope",
    "Acceptance criteria",
    "Verification",
    "Context",
)
PLAN_HEADINGS = (
    "Outcome",
    "Scope",
    "Constraints",
    "Test seams",
    "Discoveries",
)


class PacketError(Exception):
    pass


def h2_sections(text: str) -> dict[str, tuple[str, str]]:
    matches = list(H2_RE.finditer(text))
    sections: dict[str, tuple[str, str]] = {}
    for index, match in enumerate(matches):
        title = match.group(1).strip()
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections[title.lower()] = (title, text[start:end].strip())
    return sections


def copy_headings(sections: dict[str, tuple[str, str]], names: tuple[str, ...]) -> str:
    parts: list[str] = []
    for name in names:
        item = sections.get(name.lower())
        if item is None:
            continue
        title, body = item
        parts.append(f"## {title}")
        if body:
            parts.append(body)
        parts.append("")
    return "\n".join(parts).strip()


def task_ids(task: str) -> list[str]:
    ids = [task]
    if task.isdigit():
        ids.append(str(int(task)))
        ids.append(str(int(task)).zfill(2))
    seen: list[str] = []
    for item in ids:
        if item not in seen:
            seen.append(item)
    return seen


def find_task_file(ticket_dir: Path, task: str) -> Path:
    matches: list[Path] = []
    seen: set[Path] = set()
    for task_id in task_ids(task):
        for path in sorted(ticket_dir.glob(f"{task_id}-task-*.md")):
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            matches.append(path)
    if not matches:
        raise PacketError(f"no task file matching {task}-task-*.md in {ticket_dir}")
    if len(matches) > 1:
        names = ", ".join(path.name for path in matches)
        raise PacketError(f"ambiguous task file for {task}: {names}")
    return matches[0]


def task_map_rows(body: str, task: str) -> str:
    lines: list[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        for task_id in task_ids(task):
            if re.match(rf"^[-*]?\s*{re.escape(task_id)}[\s:.)]", stripped):
                lines.append(line.rstrip())
                break
            if re.search(rf"\btask\s+{re.escape(task_id)}\b", stripped, re.I):
                lines.append(line.rstrip())
                break
    return "\n".join(lines)


def git(worktree: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(worktree), *args],
        capture_output=True,
        text=True,
    )


def git_ok(result: subprocess.CompletedProcess[str], action: str) -> str:
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip() or f"exit {result.returncode}"
        raise PacketError(f"{action}: {detail}")
    return result.stdout


def git_diff_text(result: subprocess.CompletedProcess[str], action: str) -> str:
    if result.returncode not in (0, 1):
        detail = (result.stderr or result.stdout or "").strip() or f"exit {result.returncode}"
        raise PacketError(f"{action}: {detail}")
    return result.stdout


def resolve_base(worktree: Path, base: str) -> str:
    result = git(worktree, "rev-parse", "--verify", "--end-of-options", f"{base}^{{commit}}")
    sha = git_ok(result, f"invalid base {base}").strip()
    if not sha:
        raise PacketError(f"invalid base {base}")
    return sha


def default_factory_root(worktree: Path) -> Path:
    result = git(worktree, "rev-parse", "--show-toplevel")
    root = git_ok(result, "git rev-parse --show-toplevel").strip()
    return Path(root) / ".factory"


def untracked_files(worktree: Path) -> list[str]:
    result = git(worktree, "ls-files", "--others", "--exclude-standard")
    text = git_ok(result, "git ls-files --others")
    return [line for line in text.splitlines() if line]


def untracked_diff(worktree: Path, paths: list[str]) -> str:
    parts: list[str] = []
    for rel in paths:
        result = subprocess.run(
            ["git", "diff", "--no-index", "--", "/dev/null", rel],
            cwd=worktree,
            capture_output=True,
            text=True,
        )
        parts.append(git_diff_text(result, f"git diff --no-index {rel}").rstrip())
    return "\n".join(part for part in parts if part)


def line_count(text: str) -> int:
    if not text:
        return 0
    return text.count("\n") if text.endswith("\n") else text.count("\n") + 1


def build_packet(
    *,
    ticket: str,
    task: str,
    round_n: int,
    base: str,
    base_sha: str,
    plan_path: Path,
    task_path: Path,
    stat: str,
    untracked: list[str],
    diff_path: Path,
    diff_text: str,
) -> str:
    task_sections = h2_sections(task_path.read_text())
    plan_sections = h2_sections(plan_path.read_text())
    task_intent = copy_headings(task_sections, TASK_HEADINGS)
    plan_intent = copy_headings(plan_sections, PLAN_HEADINGS)
    map_item = plan_sections.get("task map")
    map_rows = task_map_rows(map_item[1], task) if map_item else ""
    if map_rows:
        plan_intent = (
            f"{plan_intent}\n\n## Task map\n{map_rows}".strip()
            if plan_intent
            else f"## Task map\n{map_rows}"
        )

    untracked_block = "\n".join(f"- {path}" for path in untracked) if untracked else "none"

    parts = [
        "# Review packet",
        "",
        f"Ticket: {ticket}",
        f"Task: {task}",
        f"Round: {round_n}",
        f"Base: {base_sha} ({base})",
        "",
        "The diff is the cumulative uncommitted ticket change. Review this task's intent; treat earlier-task hunks as context unless they regress this task. Start with the diff. Read surrounding code only where a hunk lacks context.",
        "",
        "## Intent",
        "",
        "### Task",
        f"Path: {task_path}",
        "",
    ]
    if task_intent:
        parts.extend([task_intent, ""])
    parts.extend(
        [
            "### Plan",
            f"Path: {plan_path}",
            "",
        ]
    )
    if plan_intent:
        parts.extend([plan_intent, ""])
    parts.extend(
        [
            "## Scope",
            "",
            "### Stat",
            "```",
            stat.rstrip() or "(no tracked changes)",
            "```",
            "",
            "### Untracked",
            untracked_block,
            "",
            "### Diff",
            f"Path: {diff_path} ({line_count(diff_text)} lines)",
            "",
        ]
    )
    return "\n".join(parts)


def run(args: argparse.Namespace) -> int:
    worktree = args.worktree.resolve()
    out_dir = args.out.resolve()
    factory_root = (
        args.factory_root.resolve() if args.factory_root else default_factory_root(worktree)
    )
    ticket_dir = factory_root / "tickets" / args.ticket
    plan_path = ticket_dir / "plan.md"
    if not plan_path.is_file():
        raise PacketError(f"missing plan: {plan_path}")
    task_path = find_task_file(ticket_dir, args.task)

    stem = f"{args.ticket}-T{args.task}-R{args.round}"
    packet_path = out_dir / f"{stem}-packet.md"
    diff_path = out_dir / f"{stem}.diff"

    base_sha = resolve_base(worktree, args.base)
    stat = git_diff_text(git(worktree, "diff", "--stat", args.base), "git diff --stat")
    tracked_diff = git_diff_text(git(worktree, "diff", args.base), "git diff")
    extra = untracked_files(worktree)
    extra_diff = untracked_diff(worktree, extra)
    diff_parts = [tracked_diff.rstrip(), extra_diff]
    diff_text = "\n".join(part for part in diff_parts if part)
    if diff_text and not diff_text.endswith("\n"):
        diff_text += "\n"

    packet = build_packet(
        ticket=args.ticket,
        task=args.task,
        round_n=args.round,
        base=args.base,
        base_sha=base_sha,
        plan_path=plan_path.resolve(),
        task_path=task_path.resolve(),
        stat=stat,
        untracked=extra,
        diff_path=diff_path,
        diff_text=diff_text,
    )
    if not packet.endswith("\n"):
        packet += "\n"

    out_dir.mkdir(parents=True, exist_ok=True)
    packet_path.write_text(packet)
    diff_path.write_text(diff_text)
    sys.stdout.write(f"packet: {packet_path}\n")
    sys.stdout.write(f"diff: {diff_path}\n")
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="review-packet.py",
        description="Build a reviewer packet from plan/task intent and the worktree diff.",
    )
    parser.add_argument("--ticket", required=True, help="Ticket id, e.g. PROJ-14")
    parser.add_argument("--task", required=True, help="Task id, e.g. 01")
    parser.add_argument("--out", required=True, type=Path, help="Directory for packet.md and .diff")
    parser.add_argument(
        "--worktree",
        type=Path,
        default=Path.cwd(),
        help="Ticket worktree (default: cwd)",
    )
    parser.add_argument(
        "--factory-root",
        type=Path,
        help="Factory root with tickets/ (default: <git toplevel>/.factory)",
    )
    parser.add_argument(
        "--base",
        default="HEAD",
        help="Git base for the cumulative diff (default: HEAD)",
    )
    parser.add_argument("--round", type=int, default=1, help="Review round, used in output names")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        code = exc.code
        return EXIT_FAIL if code is None else int(code)
    try:
        return run(args)
    except PacketError as exc:
        print(exc, file=sys.stderr)
        return EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())
