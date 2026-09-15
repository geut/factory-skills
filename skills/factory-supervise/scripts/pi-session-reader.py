#!/usr/bin/env python3
"""Read a Pi session JSONL once after a subagent steer.

Subcommands:
  last-message              Last non-empty assistant text on the active branch
  contract --schema NAME    Last factory markdown Output template matching NAME
  usage                     Billed token and cost totals through the last entry

Do not poll the session file. Run this once after pi-herdr-subagents steers.
Never generate inline Python to parse Pi JSONL.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

EXIT_OK = 0
EXIT_IO = 1
EXIT_ARGS = 2
EXIT_NOT_FOUND = 3
EXIT_INVALID = 4

SCHEMAS = {
    "factory.plan.v3": "## Artifacts",
    "factory.work.v3": "## Review responses",
    "factory.review.v4": "## Verdict",
    "factory.wrapup.v1": "## Merge commands",
}

REVIEW_VERDICTS = {"approve", "changes_requested", "blocked"}
PLAN_STATUSES = {"planned", "blocked"}
WORK_STATUSES = {"ready_for_review", "blocked"}
SEVERITIES = {"critical", "major", "minor"}
BLOCKING_SEVERITIES = {"critical", "major"}
E2E_RESULTS = {"passed", "failed", "not_feasible"}
WRAPUP_HEADINGS = (
    "Outcome",
    "PR summary",
    "Files",
    "Tests",
    "Operations",
    "Limitations",
    "Merge commands",
)

H2_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)
FINDING_HEAD_RE = re.compile(
    r"^###\s+(\d+)\.\s+\[([^\]]+)\]\s+(.+?)\s*$",
    re.MULTILINE,
)
FIELD_RE = re.compile(r"^\*\*([^*]+):\*\*\s*(.*)$")
TASK_RE = re.compile(
    r"^-\s+(\d+)\s*:\s+(\S+)(?:\s+\(([^)]*)\))?\s*$",
)
TEST_RE = re.compile(
    r"^-\s+(?:`([^`]+)`|(.+?)):\s*(passed|failed|not_run)\s*(?:[—–-]\s*(.*))?\s*$",
    re.IGNORECASE,
)
RESPONSE_RE = re.compile(
    r"^-\s+(R\d+-\d+)\s*:\s*(fixed|not_fixed|disputed)\s*(?:[—–-]\s*(.*))?\s*$",
    re.IGNORECASE,
)
FENCE_RE = re.compile(r"```(?:markdown|md|json)?\s*\n?", re.IGNORECASE)


class SessionError(Exception):
    def __init__(self, message: str, code: int = EXIT_IO) -> None:
        super().__init__(message)
        self.code = code


class ContractError(Exception):
    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


def load_entries(path: Path) -> list[dict[str, Any]]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise SessionError(f"cannot read {path}: {exc}") from exc
    entries: list[dict[str, Any]] = []
    for lineno, line in enumerate(raw.splitlines(), 1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SessionError(f"{path}:{lineno}: invalid JSONL: {exc}") from exc
        if not isinstance(obj, dict):
            raise SessionError(f"{path}:{lineno}: JSONL entry is not an object")
        entries.append(obj)
    return entries


def active_branch(entries: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    session: dict[str, Any] | None = None
    by_id: dict[str, dict[str, Any]] = {}
    last_id: str | None = None
    for entry in entries:
        if entry.get("type") == "session":
            session = entry
            continue
        entry_id = entry.get("id")
        if isinstance(entry_id, str) and entry_id:
            by_id[entry_id] = entry
            last_id = entry_id
    if last_id is None:
        return session, []
    path: list[dict[str, Any]] = []
    seen: set[str] = set()
    current: str | None = last_id
    while current and current not in seen:
        seen.add(current)
        entry = by_id.get(current)
        if entry is None:
            break
        path.append(entry)
        parent = entry.get("parentId")
        current = parent if isinstance(parent, str) and parent else None
    path.reverse()
    return session, path


def _message(entry: dict[str, Any]) -> dict[str, Any] | None:
    message = entry.get("message")
    return message if isinstance(message, dict) else None


def assistant_text(entry: dict[str, Any]) -> str:
    message = _message(entry)
    if message is None or message.get("role") != "assistant":
        return ""
    content = message.get("content")
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "text":
            continue
        text = item.get("text")
        if isinstance(text, str) and text.strip():
            parts.append(text)
    return "\n".join(parts)


def last_assistant_text(branch: list[dict[str, Any]]) -> str | None:
    for entry in reversed(branch):
        text = assistant_text(entry)
        if text:
            return text
    return None


def unwrap_fences(text: str) -> str:
    return FENCE_RE.sub("", text).replace("```", "")


def last_contract_text(branch: list[dict[str, Any]], marker: str) -> str | None:
    last: str | None = None
    for entry in branch:
        text = assistant_text(entry)
        if text and marker.lower() in unwrap_fences(text).lower():
            last = text
    return last


def h2_sections(text: str) -> dict[str, str]:
    cleaned = unwrap_fences(text)
    matches = list(H2_RE.finditer(cleaned))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        title = match.group(1).strip()
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(cleaned)
        sections[title.lower()] = cleaned[start:end].strip()
    return sections


def require_section(sections: dict[str, str], name: str, errors: list[str]) -> str:
    body = sections.get(name.lower(), "")
    if name.lower() not in sections:
        errors.append(f"missing ## {name}")
    return body


def first_token(body: str) -> str:
    for line in body.splitlines():
        stripped = line.strip().strip("`").strip("*")
        if stripped:
            return stripped.split()[0].lower()
    return ""


def section_text(body: str) -> str:
    return "\n".join(line.rstrip() for line in body.splitlines()).strip()


def is_none(body: str) -> bool:
    return section_text(body).lower() == "none"


def bullet_lines(body: str) -> list[str]:
    lines: list[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("- "):
            lines.append(stripped[2:].strip())
    return lines


def parse_findings(body: str, round_n: int, errors: list[str]) -> list[dict[str, Any]]:
    if is_none(body):
        return []
    heads = list(FINDING_HEAD_RE.finditer(body))
    if not heads:
        errors.append("## Findings must be none or a numbered list")
        return []
    findings: list[dict[str, Any]] = []
    for index, match in enumerate(heads):
        number = int(match.group(1))
        severity = match.group(2).strip().lower()
        title = match.group(3).strip()
        start = match.end()
        end = heads[index + 1].start() if index + 1 < len(heads) else len(body)
        fields = _finding_fields(body[start:end])
        if severity not in SEVERITIES:
            errors.append(f"findings[{index}] severity must be critical, major, or minor")
        for key in ("location", "finding", "evidence"):
            if not fields.get(key):
                errors.append(f"findings[{index}] missing {key}")
        finding_id = f"R{round_n}-{number:02d}"
        findings.append(
            {
                "id": finding_id,
                "index": number,
                "severity": severity,
                "blocking": severity in BLOCKING_SEVERITIES,
                "title": title,
                "location": fields.get("location") or "",
                "finding": fields.get("finding") or "",
                "evidence": fields.get("evidence") or "",
                "suggestion": fields.get("suggestion") or None,
            }
        )
    return findings


def _finding_fields(block: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    current: str | None = None
    parts: list[str] = []
    for line in block.splitlines():
        match = FIELD_RE.match(line.strip())
        if match:
            if current is not None:
                fields[current] = "\n".join(parts).strip()
            current = match.group(1).strip().lower()
            parts = [match.group(2).strip()] if match.group(2).strip() else []
            continue
        if current is not None:
            parts.append(line.strip())
    if current is not None:
        fields[current] = "\n".join(parts).strip()
    return fields


def parse_review(text: str, round_n: int) -> dict[str, Any]:
    sections = h2_sections(text)
    errors: list[str] = []
    verdict_body = require_section(sections, "Verdict", errors)
    summary_body = require_section(sections, "Summary", errors)
    findings_body = require_section(sections, "Findings", errors)
    verdict = first_token(verdict_body)
    if verdict and verdict not in REVIEW_VERDICTS:
        errors.append("verdict must be approve, changes_requested, or blocked")
    if verdict_body and not verdict:
        errors.append("verdict must be approve, changes_requested, or blocked")
    summary = section_text(summary_body)
    if "summary" in sections and not summary:
        errors.append("summary must not be empty")
    findings = parse_findings(findings_body, round_n, errors) if "findings" in sections else []
    blocking = [item for item in findings if item.get("blocking")]
    if verdict == "approve" and blocking:
        errors.append("approve requires no blocking findings")
    if verdict == "changes_requested" and not blocking:
        errors.append("changes_requested requires at least one blocking finding")
    if errors:
        raise ContractError(errors)
    return {
        "schema": "factory.review.v4",
        "verdict": verdict,
        "summary": summary,
        "findings": findings,
        "findingCount": len(findings),
        "blockingCount": len(blocking),
    }


def parse_plan(text: str) -> dict[str, Any]:
    sections = h2_sections(text)
    errors: list[str] = []
    status_body = require_section(sections, "Status", errors)
    artifacts_body = require_section(sections, "Artifacts", errors)
    ready_body = require_section(sections, "Ready", errors)
    assumptions_body = require_section(sections, "Assumptions", errors)
    blocker_body = require_section(sections, "Blocker", errors)
    status = first_token(status_body)
    if status and status not in PLAN_STATUSES:
        errors.append("status must be planned or blocked")
    plan = None
    adr = None
    tasks: list[dict[str, Any]] = []
    for raw in artifacts_body.splitlines():
        line = raw.strip()
        if line.lower().startswith("- plan:"):
            plan = line.split(":", 1)[1].strip()
            if plan.lower() == "none":
                plan = None
        elif line.lower().startswith("- adr:"):
            adr = line.split(":", 1)[1].strip()
            if adr.lower() == "none":
                adr = None
        else:
            task_match = TASK_RE.match(line)
            if task_match:
                blocked_by: list[str] = []
                meta = task_match.group(3) or ""
                task_status = "pending"
                if meta:
                    parts = [part.strip() for part in meta.split(",")]
                    if parts:
                        task_status = parts[0]
                    if len(parts) > 1 and parts[1].lower().startswith("blockedby"):
                        rest = parts[1].split(None, 1)
                        value = rest[1] if len(rest) > 1 else "none"
                        if value.lower() != "none":
                            blocked_by = [item.strip() for item in value.split() if item.strip()]
                tasks.append(
                    {
                        "id": task_match.group(1),
                        "path": task_match.group(2),
                        "status": task_status,
                        "blockedBy": blocked_by,
                    }
                )
    ready = [] if is_none(ready_body) else [
        token.strip().strip(",")
        for token in re.split(r"[\s,]+", section_text(ready_body))
        if token.strip() and token.strip().lower() != "none"
    ]
    assumptions = [] if is_none(assumptions_body) else bullet_lines(assumptions_body) or (
        [section_text(assumptions_body)] if section_text(assumptions_body) else []
    )
    blocker = None if is_none(blocker_body) else section_text(blocker_body) or None
    if status == "blocked" and blocker is None:
        errors.append("blocked requires a blocker")
    if status == "planned" and ready and not tasks:
        errors.append("planned ready tasks need artifact paths")
    if errors:
        raise ContractError(errors)
    return {
        "schema": "factory.plan.v3",
        "status": status,
        "plan": plan,
        "adr": adr,
        "tasks": tasks,
        "readyTasks": ready,
        "assumptions": assumptions,
        "blocker": blocker,
    }


def parse_work(text: str) -> dict[str, Any]:
    sections = h2_sections(text)
    errors: list[str] = []
    status_body = require_section(sections, "Status", errors)
    summary_body = require_section(sections, "Summary", errors)
    tests_body = require_section(sections, "Tests", errors)
    e2e_body = require_section(sections, "E2E", errors)
    responses_body = require_section(sections, "Review responses", errors)
    plan_body = require_section(sections, "Plan changed", errors)
    blocker_body = require_section(sections, "Blocker", errors)
    status = first_token(status_body)
    if status and status not in WORK_STATUSES:
        errors.append("status must be ready_for_review or blocked")
    summary = section_text(summary_body)
    if "summary" in sections and not summary:
        errors.append("summary must not be empty")
    tests: list[dict[str, Any]] = []
    for line in tests_body.splitlines():
        match = TEST_RE.match(line.strip())
        if not match:
            continue
        command = match.group(1) or (match.group(2) or "").strip()
        tests.append(
            {
                "command": command,
                "result": match.group(3).lower(),
                "note": (match.group(4) or "").strip() or None,
            }
        )
    if "tests" in sections and not tests and not is_none(tests_body):
        errors.append("tests must be none or command result lines")
    e2e_result = first_token(e2e_body)
    e2e_note = None
    if e2e_body:
        lines = [line.strip() for line in e2e_body.splitlines() if line.strip()]
        if lines:
            first = re.split(r"\s+", lines[0], maxsplit=1)
            e2e_result = first[0].lower()
            rest = first[1] if len(first) > 1 else ""
            note_lines = [rest] if rest else []
            for extra in lines[1:]:
                if extra.lower().startswith("note:"):
                    note_lines.append(extra.split(":", 1)[1].strip())
                else:
                    note_lines.append(extra)
            e2e_note = " ".join(part for part in note_lines if part) or None
    if e2e_result and e2e_result not in E2E_RESULTS:
        errors.append("e2e must be passed, failed, or not_feasible")
    responses: list[dict[str, Any]] = []
    if not is_none(responses_body):
        for line in responses_body.splitlines():
            match = RESPONSE_RE.match(line.strip())
            if match:
                responses.append(
                    {
                        "finding": match.group(1),
                        "disposition": match.group(2).lower(),
                        "evidence": (match.group(3) or "").strip() or None,
                    }
                )
        if "review responses" in sections and not responses and section_text(responses_body):
            errors.append("review responses must be none or R{round}-{n} disposition lines")
    plan_changed_token = first_token(plan_body)
    plan_changed = {"true": True, "false": False}.get(plan_changed_token)
    if "plan changed" in sections and plan_changed is None:
        errors.append("plan changed must be true or false")
    blocker = None if is_none(blocker_body) else section_text(blocker_body) or None
    if status == "blocked" and blocker is None:
        errors.append("blocked requires a blocker")
    if errors:
        raise ContractError(errors)
    return {
        "schema": "factory.work.v3",
        "status": status,
        "summary": summary,
        "tests": tests,
        "e2e": {"result": e2e_result, "note": e2e_note},
        "reviewResponses": responses,
        "planChanged": bool(plan_changed),
        "blocker": blocker,
    }


def parse_wrapup(text: str) -> dict[str, Any]:
    sections = h2_sections(text)
    errors: list[str] = []
    present: dict[str, str] = {}
    for name in WRAPUP_HEADINGS:
        body = require_section(sections, name, errors)
        if name.lower() in sections and not section_text(body):
            errors.append(f"## {name} must not be empty")
        present[name] = section_text(body)
    if errors:
        raise ContractError(errors)
    return {"schema": "factory.wrapup.v1", "headings": present}


def parse_contract(text: str, schema: str, round_n: int = 1) -> dict[str, Any]:
    if schema == "factory.review.v4":
        return parse_review(text, round_n)
    if schema == "factory.plan.v3":
        return parse_plan(text)
    if schema == "factory.work.v3":
        return parse_work(text)
    if schema == "factory.wrapup.v1":
        return parse_wrapup(text)
    raise SessionError(f"unknown schema {schema}", EXIT_ARGS)


def last_contract(branch: list[dict[str, Any]], schema: str, round_n: int = 1) -> dict[str, Any] | None:
    marker = SCHEMAS.get(schema)
    if marker is None:
        raise SessionError(f"unknown schema {schema}", EXIT_ARGS)
    text = last_contract_text(branch, marker)
    if text is None:
        return None
    return parse_contract(text, schema, round_n)


def check_line(obj: dict[str, Any]) -> str:
    schema = obj["schema"]
    if schema == "factory.review.v4":
        return (
            f"ok {schema} verdict={obj['verdict']} "
            f"findings={obj['findingCount']} blocking={obj['blockingCount']}"
        )
    if schema == "factory.plan.v3":
        ready = ",".join(obj.get("readyTasks") or []) or "none"
        return f"ok {schema} status={obj['status']} ready={ready}"
    if schema == "factory.work.v3":
        return f"ok {schema} status={obj['status']}"
    if schema == "factory.wrapup.v1":
        return f"ok {schema} headings={len(obj.get('headings') or {})}"
    return f"ok {schema}"


def entry_usage(entry: dict[str, Any]) -> dict[str, Any] | None:
    message = _message(entry)
    if message is not None and isinstance(message.get("usage"), dict):
        return message["usage"]
    usage = entry.get("usage")
    return usage if isinstance(usage, dict) else None


def _number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    return float(value)


def assistant_model(entry: dict[str, Any]) -> str | None:
    message = _message(entry)
    if message is None or message.get("role") != "assistant":
        return None
    provider = message.get("provider")
    model = message.get("model")
    if isinstance(provider, str) and provider and isinstance(model, str) and model:
        return f"{provider}/{model}"
    if isinstance(model, str) and model:
        return model
    if isinstance(provider, str) and provider:
        return provider
    return None


def usage_record(session: dict[str, Any] | None, branch: list[dict[str, Any]]) -> dict[str, Any]:
    tokens = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
    cost = 0.0
    model: str | None = None
    for entry in branch:
        usage = entry_usage(entry)
        if usage is not None:
            tokens["input"] += int(_number(usage.get("input")))
            tokens["output"] += int(_number(usage.get("output")))
            tokens["cacheRead"] += int(_number(usage.get("cacheRead")))
            tokens["cacheWrite"] += int(_number(usage.get("cacheWrite")))
            if "totalTokens" in usage:
                tokens["total"] += int(_number(usage.get("totalTokens")))
            cost_obj = usage.get("cost")
            if isinstance(cost_obj, dict):
                cost += _number(cost_obj.get("total"))
        found = assistant_model(entry)
        if found:
            model = found
    through = None
    if branch:
        last_id = branch[-1].get("id")
        if isinstance(last_id, str):
            through = last_id
    session_id = session.get("id") if session else None
    return {
        "sessionId": session_id if isinstance(session_id, str) else None,
        "throughEntryId": through,
        "model": model,
        "tokens": tokens,
        "costUsd": cost,
    }


def cmd_last_message(branch: list[dict[str, Any]]) -> int:
    text = last_assistant_text(branch)
    if text is None:
        print("no assistant text on the active branch", file=sys.stderr)
        return EXIT_NOT_FOUND
    sys.stdout.write(text if text.endswith("\n") else text + "\n")
    return EXIT_OK


def cmd_contract(branch: list[dict[str, Any]], schema: str, check: bool, round_n: int) -> int:
    marker = SCHEMAS.get(schema)
    if marker is None:
        print(f"unknown schema {schema}", file=sys.stderr)
        return EXIT_ARGS
    text = last_contract_text(branch, marker)
    if text is None:
        print(f"no {schema} template in assistant text on the active branch", file=sys.stderr)
        return EXIT_NOT_FOUND
    try:
        obj = parse_contract(text, schema, round_n)
    except ContractError as exc:
        print(f"invalid {schema}: " + "; ".join(exc.errors), file=sys.stderr)
        return EXIT_INVALID
    if check:
        sys.stdout.write(check_line(obj) + "\n")
        return EXIT_OK
    json.dump(obj, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return EXIT_OK


def cmd_usage(session: dict[str, Any] | None, branch: list[dict[str, Any]]) -> int:
    json.dump(usage_record(session, branch), sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pi-session-reader.py",
        description="Read a Pi session JSONL after a subagent steer. Do not poll.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    last_message = sub.add_parser("last-message", help="Print the last non-empty assistant text")
    last_message.add_argument("session", type=Path, help="Path to the Pi session JSONL")

    contract = sub.add_parser("contract", help="Parse the last matching factory Output template")
    contract.add_argument(
        "--schema",
        required=True,
        help="Contract schema, e.g. factory.review.v4",
    )
    contract.add_argument(
        "--check",
        action="store_true",
        help="Print one-line pass/fail instead of JSON",
    )
    contract.add_argument(
        "--print",
        dest="print_json",
        action="store_true",
        help="Print compact JSON (default when --check is omitted)",
    )
    contract.add_argument(
        "--round",
        dest="round_n",
        type=int,
        default=1,
        help="Review round used to synthesize R{round}-{n} finding ids",
    )
    contract.add_argument("session", type=Path, help="Path to the Pi session JSONL")

    usage = sub.add_parser("usage", help="Print billed token and cost totals")
    usage.add_argument("session", type=Path, help="Path to the Pi session JSONL")
    return parser


def run(
    command: str,
    session_path: Path,
    schema: str | None = None,
    check: bool = False,
    round_n: int = 1,
) -> int:
    entries = load_entries(session_path)
    session, branch = active_branch(entries)
    if command == "last-message":
        return cmd_last_message(branch)
    if command == "contract":
        if not schema:
            print("--schema is required", file=sys.stderr)
            return EXIT_ARGS
        return cmd_contract(branch, schema, check, round_n)
    if command == "usage":
        return cmd_usage(session, branch)
    print(f"unknown command: {command}", file=sys.stderr)
    return EXIT_ARGS


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        code = exc.code
        return EXIT_ARGS if code is None else int(code)
    try:
        return run(
            args.command,
            args.session,
            getattr(args, "schema", None),
            getattr(args, "check", False),
            getattr(args, "round_n", 1),
        )
    except SessionError as exc:
        print(exc, file=sys.stderr)
        return exc.code


if __name__ == "__main__":
    sys.exit(main())
