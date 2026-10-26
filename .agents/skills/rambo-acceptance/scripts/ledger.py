#!/usr/bin/env python3
"""Deterministic local ledger for Rambo acceptance runs.

This CLI records observations and coordinator reviews. Its actor flags are
workflow guardrails only; they do not provide authentication or authorization.
It never launches the application or controls the computer.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


RUN_SCHEMA = "rambo.acceptance.run.v1"
LEGACY_CASES_SCHEMA = "rambo.acceptance.cases.v1"
CASES_SCHEMA = "rambo.acceptance.cases.v2"
ISSUES_SCHEMA = "rambo.acceptance.issues.v1"
STATUS_VALUES = ("not_run", "pass", "fail", "blocked", "clarify")
VERIFY_VALUES = ("pass", "fail", "blocked", "clarify")
STATUS_ZH = {
    "not_run": "未执行",
    "pass": "通过",
    "fail": "失败",
    "blocked": "受阻",
    "clarify": "待澄清",
}
DECISIONS_REL = "docs/product-decisions.md"
MATRIX_REL = "docs/acceptance-matrix.md"
CATALOG_REL = "tests/acceptance/catalog.json"
DEV_BUILD_INPUTS = (
    "src",
    "assets",
    "runtime/codex",
    "scripts/desktop.mjs",
    "electron.vite.config.ts",
    "tsconfig.json",
    "package.json",
    "package-lock.json",
)


class LedgerError(Exception):
    """Expected input or ledger-state error presented without a traceback."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _lstat(path: Path) -> os.stat_result | None:
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


def _require_regular_file(path: Path, label: str) -> None:
    info = _lstat(path)
    if info is None:
        raise LedgerError(f"{label}不存在：{path}")
    if stat.S_ISLNK(info.st_mode):
        raise LedgerError(f"{label}不能是符号链接：{path}")
    if not stat.S_ISREG(info.st_mode):
        raise LedgerError(f"{label}必须是普通文件：{path}")


def _require_real_directory(path: Path, label: str) -> None:
    info = _lstat(path)
    if info is None:
        raise LedgerError(f"{label}不存在：{path}")
    if stat.S_ISLNK(info.st_mode):
        raise LedgerError(f"{label}不能是符号链接：{path}")
    if not stat.S_ISDIR(info.st_mode):
        raise LedgerError(f"{label}必须是目录：{path}")


def _read_json(path: Path, label: str) -> dict[str, Any]:
    _require_regular_file(path, label)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise LedgerError(f"{label}不是有效 JSON：{exc}") from exc
    if not isinstance(value, dict):
        raise LedgerError(f"{label}的顶层必须是 JSON 对象")
    return value


def _write_json(path: Path, value: dict[str, Any]) -> None:
    _require_regular_file(path, path.name)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=False)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _append_audit(run_dir: Path, action: str, actor: str, details: dict[str, Any]) -> str:
    path = run_dir / "audit.jsonl"
    _require_regular_file(path, "audit.jsonl")
    event_id = uuid.uuid4().hex
    event = {
        "eventId": event_id,
        "at": now_iso(),
        "action": action,
        "actor": actor,
        "details": details,
    }
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    return event_id


def _check_actor(actual: str, expected: str, command: str) -> None:
    if actual != expected:
        raise LedgerError(
            f"{command}要求 --actor {expected}；actor 参数只是流程护栏，不是安全授权"
        )


def _project_docs(project: Path) -> tuple[Path, Path, Path]:
    decisions = project / DECISIONS_REL
    matrix = project / MATRIX_REL
    catalog = project / CATALOG_REL
    _require_regular_file(decisions, DECISIONS_REL)
    _require_regular_file(matrix, MATRIX_REL)
    _require_regular_file(catalog, CATALOG_REL)
    return decisions, matrix, catalog


def _parse_markdown_table_rows(path: Path, *, allow_flow: bool) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError as exc:
        raise LedgerError(f"{path.name}不是 UTF-8 文本") from exc

    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = [cell.strip() for cell in stripped[1:-1].split("|")]
        if len(cells) < 2:
            continue
        first = cells[0]
        match = re.match(r"^([A-Z]\d{2})(?:\s+(.+))?$", first)
        if not match:
            continue
        rule_id, flow_title = match.group(1), match.group(2)
        is_flow = rule_id.startswith("E")
        if is_flow and not allow_flow:
            continue
        if is_flow:
            title = (flow_title or (cells[1] if len(cells) > 1 else "")).strip()
            row_kind = "flow"
        else:
            title = cells[1] if len(cells) > 1 else ""
            row_kind = "rule"
        rows.append(
            {
                "id": rule_id,
                "title": title,
                "kind": row_kind,
                "sourceLine": line_number,
                "source": line,
                "columns": cells,
            }
        )
    return rows


def _parse_scope(
    project: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, str]]:
    decisions_path, matrix_path, catalog_path = _project_docs(project)
    decisions = _parse_markdown_table_rows(decisions_path, allow_flow=False)
    matrix_rows = _parse_markdown_table_rows(matrix_path, allow_flow=True)
    decision_ids = [row["id"] for row in decisions]
    rule_rows = [row for row in matrix_rows if row["kind"] == "rule"]
    matrix_ids = [row["id"] for row in rule_rows]

    for label, ids in (("product-decisions.md", decision_ids), ("acceptance-matrix.md", rule_ids := [r["id"] for r in matrix_rows])):
        duplicates = sorted({item for item in ids if ids.count(item) > 1})
        if duplicates:
            raise LedgerError(f"{label}存在重复编号：{', '.join(duplicates)}")
    if not decisions:
        raise LedgerError("product-decisions.md未解析出编号规则")
    if not rule_rows:
        raise LedgerError("acceptance-matrix.md未解析出编号规则")

    missing = sorted(set(decision_ids) - set(matrix_ids))
    extra = sorted(set(matrix_ids) - set(decision_ids))
    if missing or extra:
        parts = []
        if missing:
            parts.append("矩阵缺少决策编号 " + ", ".join(missing))
        if extra:
            parts.append("矩阵有决策文档未定义的编号 " + ", ".join(extra))
        raise LedgerError("；".join(parts))

    decision_titles = {row["id"]: row["title"] for row in decisions}
    matrix_by_id = {row["id"]: row for row in rule_rows}
    for row in rule_rows:
        row["decisionTitle"] = decision_titles[row["id"]]

    catalog = _read_json(catalog_path, CATALOG_REL)
    if catalog.get("schema") != "rambo.test.catalog.v1":
        raise LedgerError("catalog.json schema不匹配，期望 rambo.test.catalog.v1")
    journeys = catalog.get("journeys")
    release_suites = catalog.get("releaseSuites")
    acceptance_rows = catalog.get("ruleAcceptance")
    if not isinstance(journeys, list) or not journeys:
        raise LedgerError("catalog.json缺少非空journeys")
    if not isinstance(release_suites, list):
        raise LedgerError("catalog.json缺少releaseSuites")
    if not isinstance(acceptance_rows, list) or not acceptance_rows:
        raise LedgerError("catalog.json缺少非空ruleAcceptance")

    groups_by_rule: dict[str, list[str]] = {}
    for group_kind, groups in (("journey", journeys), ("release-suite", release_suites)):
        for group in groups:
            if not isinstance(group, dict):
                raise LedgerError(f"catalog.json中的{group_kind}必须为对象")
            group_id = _nonempty_text(group.get("id"), f"{group_kind}.id")
            _nonempty_text(group.get("title"), f"{group_kind}.{group_id}.title")
            group_rules = group.get("rules")
            if not isinstance(group_rules, list) or not group_rules:
                raise LedgerError(f"{group_id}.rules必须为非空数组")
            rules_in_group: set[str] = set()
            for rule_id in group_rules:
                normalized = _nonempty_text(rule_id, f"{group_id}.rules")
                if normalized not in decision_titles:
                    raise LedgerError(f"{group_id}引用未知规则 {normalized}")
                if normalized in rules_in_group:
                    raise LedgerError(f"{group_id}.rules重复包含规则 {normalized}")
                rules_in_group.add(normalized)
                groups_by_rule.setdefault(normalized, []).append(group_id)

    acceptance_by_rule: dict[str, dict[str, Any]] = {}
    catalog_cases = catalog.get("cases")
    if not isinstance(catalog_cases, list) or not catalog_cases:
        raise LedgerError("catalog.json缺少非空cases")
    catalog_case_ids: set[str] = set()
    for test_case in catalog_cases:
        if not isinstance(test_case, dict):
            raise LedgerError("catalog.json中的cases项必须为对象")
        case_id = _nonempty_text(test_case.get("id"), "catalog.cases.id")
        if case_id in catalog_case_ids:
            raise LedgerError(f"catalog.json局部测试案例重复：{case_id}")
        catalog_case_ids.add(case_id)
        case_rules = _text_list(test_case.get("rules"), f"{case_id}.rules")
        unknown_case_rules = sorted(set(case_rules) - set(decision_ids))
        if unknown_case_rules:
            raise LedgerError(f"{case_id}引用未知规则：" + ", ".join(unknown_case_rules))
        if test_case.get("status") not in ("implemented", "not_implemented"):
            raise LedgerError(f"{case_id}.status必须为implemented或not_implemented")
        _nonempty_text(test_case.get("gate"), f"{case_id}.gate")
        _nonempty_text(test_case.get("layer"), f"{case_id}.layer")
        _nonempty_text(test_case.get("target"), f"{case_id}.target")
    for acceptance in acceptance_rows:
        if not isinstance(acceptance, dict):
            raise LedgerError("catalog.json中的ruleAcceptance项必须为对象")
        rule_id = _nonempty_text(acceptance.get("rule"), "ruleAcceptance.rule")
        if rule_id in acceptance_by_rule:
            raise LedgerError(f"catalog.json规则验收重复：{rule_id}")
        if rule_id not in matrix_by_id:
            raise LedgerError(f"catalog.json引用未知验收规则：{rule_id}")
        if rule_id not in groups_by_rule:
            raise LedgerError(f"规则 {rule_id} 没有旅程或发布套件归属")
        scenarios = acceptance.get("scenarios")
        if not isinstance(scenarios, list) or not scenarios:
            raise LedgerError(f"{rule_id}.scenarios必须为非空数组")
        scenario_ids: list[str] = []
        for scenario in scenarios:
            if not isinstance(scenario, dict):
                raise LedgerError(f"{rule_id}.scenarios项必须为对象")
            scenario_id = _nonempty_text(scenario.get("id"), f"{rule_id}.scenario.id")
            if scenario_id in scenario_ids:
                raise LedgerError(f"{rule_id}验收场景重复：{scenario_id}")
            scenario_ids.append(scenario_id)
            _text_list(scenario.get("steps"), f"{scenario_id}.steps")
            _text_list(scenario.get("expected"), f"{scenario_id}.expected")
            _text_list(scenario.get("evidence"), f"{scenario_id}.evidence")
        acceptance_by_rule[rule_id] = acceptance

    acceptance_ids = set(acceptance_by_rule)
    if acceptance_ids != set(decision_ids):
        missing_acceptance = sorted(set(decision_ids) - acceptance_ids)
        extra_acceptance = sorted(acceptance_ids - set(decision_ids))
        parts = []
        if missing_acceptance:
            parts.append("缺少规则验收场景 " + ", ".join(missing_acceptance))
        if extra_acceptance:
            parts.append("存在未知规则验收场景 " + ", ".join(extra_acceptance))
        raise LedgerError("catalog.json与决策不一致：" + "；".join(parts))
    if set(groups_by_rule) != set(decision_ids):
        missing_groups = sorted(set(decision_ids) - set(groups_by_rule))
        raise LedgerError("catalog.json旅程和发布套件未覆盖规则：" + ", ".join(missing_groups))

    rules = []
    for row in rule_rows:
        acceptance = acceptance_by_rule[row["id"]]
        evidence_cases = [
            {
                "id": _nonempty_text(test_case.get("id"), "catalog.cases.id"),
                "gate": test_case.get("gate"),
                "layer": test_case.get("layer"),
                "target": test_case.get("target"),
                "testName": test_case.get("testName"),
                "status": test_case.get("status", "implemented"),
            }
            for test_case in catalog_cases
            if row["id"] in test_case.get("rules", [])
        ]
        rules.append(
            {
                **row,
                "acceptance": {
                    "scenarioIds": [scenario["id"] for scenario in acceptance["scenarios"]],
                    "scenarios": acceptance["scenarios"],
                    "evidence": acceptance.get("evidence", []),
                    "remaining": _nonempty_text(acceptance.get("remaining"), f"{row['id']}.remaining"),
                },
                "journeyIds": groups_by_rule[row["id"]],
                "evidenceCases": evidence_cases,
            }
        )
    hashes = {
        DECISIONS_REL: sha256_file(decisions_path),
        MATRIX_REL: sha256_file(matrix_path),
        CATALOG_REL: sha256_file(catalog_path),
    }
    return rules, journeys, release_suites, hashes


def _app_asar(app_value: str | Path) -> tuple[Path, Path, str]:
    supplied = Path(app_value).expanduser()
    if not supplied.is_absolute():
        supplied = Path.cwd() / supplied
    app_info = _lstat(supplied)
    if app_info is None:
        raise LedgerError(f"App 目录不存在：{supplied}")
    if stat.S_ISLNK(app_info.st_mode):
        raise LedgerError(f"App 目录不能是符号链接：{supplied}")
    if not stat.S_ISDIR(app_info.st_mode):
        raise LedgerError(f"--app 必须指向 Rambo.app 目录：{supplied}")

    app_path = supplied.resolve(strict=True)
    if app_path.suffix != ".app":
        raise LedgerError(f"--app 必须是 .app 目录：{app_path}")
    asar = app_path / "Contents" / "Resources" / "app.asar"
    for directory in (app_path / "Contents", app_path / "Contents" / "Resources"):
        info = _lstat(directory)
        if info is None or stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise LedgerError(f"App 内目录缺失或不是普通目录：{directory}")
    _require_regular_file(asar, "app.asar")
    return app_path, asar, sha256_file(asar)


def _dev_source_hash(project: str | Path) -> str:
    """Fingerprint the live development inputs without packaging an .app."""
    root = Path(project).resolve(strict=True)
    digest = hashlib.sha256()

    def add_file(path: Path, relative: str) -> None:
        info = _lstat(path)
        if info is None:
            raise LedgerError(f"开发构建输入在指纹计算时消失：{relative}")
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise LedgerError(f"开发构建输入必须是普通文件：{relative}")
        digest.update(b"F\0" + relative.encode("utf-8") + b"\0")
        digest.update(str(stat.S_IMODE(info.st_mode)).encode("ascii") + b"\0")
        digest.update(str(info.st_size).encode("ascii") + b"\0")
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        after = _lstat(path)
        if after is None or (after.st_size, after.st_mtime_ns, after.st_mode) != (info.st_size, info.st_mtime_ns, info.st_mode):
            raise LedgerError(f"开发构建输入在指纹计算期间发生变化：{relative}")

    for entry in DEV_BUILD_INPUTS:
        target = root / entry
        info = _lstat(target)
        digest.update(b"I\0" + entry.encode("utf-8") + b"\0")
        if info is None:
            digest.update(b"MISSING\0")
            continue
        if stat.S_ISLNK(info.st_mode):
            raise LedgerError(f"开发构建输入不能是符号链接：{entry}")
        if stat.S_ISREG(info.st_mode):
            add_file(target, entry)
            continue
        if not stat.S_ISDIR(info.st_mode):
            raise LedgerError(f"开发构建输入必须是普通文件或目录：{entry}")

        digest.update(b"D\0" + entry.encode("utf-8") + b"\0")
        for current, dirs, files in os.walk(target, followlinks=False):
            dirs.sort()
            files.sort()
            current_path = Path(current)
            current_info = _lstat(current_path)
            if current_info is None or stat.S_ISLNK(current_info.st_mode) or not stat.S_ISDIR(current_info.st_mode):
                raise LedgerError(f"开发构建输入目录在指纹计算期间变化：{current_path.relative_to(root).as_posix()}")
            current_relative = current_path.relative_to(root).as_posix()
            for name in list(dirs):
                directory = current_path / name
                directory_info = _lstat(directory)
                relative = directory.relative_to(root).as_posix()
                if directory_info is None or stat.S_ISLNK(directory_info.st_mode) or not stat.S_ISDIR(directory_info.st_mode):
                    raise LedgerError(f"开发构建输入目录不能是符号链接或特殊文件：{relative}")
                digest.update(b"D\0" + relative.encode("utf-8") + b"\0")
            for name in files:
                path = current_path / name
                add_file(path, path.relative_to(root).as_posix())
            after_directory = _lstat(current_path)
            if after_directory is None or (after_directory.st_size, after_directory.st_mtime_ns, after_directory.st_mode) != (
                current_info.st_size, current_info.st_mtime_ns, current_info.st_mode
            ):
                raise LedgerError(f"开发构建输入目录在指纹计算期间发生变化：{current_relative}")

    return digest.hexdigest()


def _safe_init_destination(project: Path, out_value: str | Path) -> tuple[Path, Path]:
    raw_out = Path(out_value).expanduser()
    if ".." in raw_out.parts:
        raise LedgerError("--out不能包含 .. 路径分量")
    out_path = raw_out if raw_out.is_absolute() else Path.cwd() / raw_out
    out_path = Path(os.path.abspath(out_path))
    if not out_path.name or out_path.name in (".", ".."):
        raise LedgerError("--out必须是 acceptance-runs 下的单个运行目录")
    expected_runs = project / "acceptance-runs"
    if out_path.parent.name != "acceptance-runs":
        raise LedgerError("--out必须位于 project/acceptance-runs/<runid>")
    parent_project = out_path.parent.parent
    try:
        parent_project_resolved = parent_project.resolve(strict=True)
    except FileNotFoundError as exc:
        raise LedgerError("--out的项目目录不存在") from exc
    if parent_project_resolved != project:
        raise LedgerError("--out必须位于指定project的 acceptance-runs/<runid> 内")
    run_id = out_path.name
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", run_id):
        raise LedgerError("runid只允许字母、数字、点、下划线和连字符，且不能以点开头")
    runs_info = _lstat(expected_runs)
    if runs_info is not None:
        if stat.S_ISLNK(runs_info.st_mode):
            raise LedgerError("acceptance-runs不能是符号链接")
        if not stat.S_ISDIR(runs_info.st_mode):
            raise LedgerError("acceptance-runs必须是目录")
    elif out_path.parent.parent.resolve(strict=True) != project:
        raise LedgerError("--out路径必须直接位于指定project/acceptance-runs")
    out_info = _lstat(out_path)
    if out_info is not None:
        if stat.S_ISLNK(out_info.st_mode):
            raise LedgerError("目标运行目录不能是符号链接")
        raise LedgerError(f"目标已存在，拒绝覆盖：{out_path}")
    return expected_runs, out_path


def _init_run(args: argparse.Namespace) -> int:
    project_arg = Path(args.project).expanduser()
    try:
        project = project_arg.resolve(strict=True)
    except FileNotFoundError as exc:
        raise LedgerError(f"project目录不存在：{project_arg}") from exc
    _require_real_directory(project, "project目录")
    if not (project / "docs").is_dir():
        raise LedgerError(f"项目缺少docs目录：{project / 'docs'}")

    runs_dir, run_dir = _safe_init_destination(project, args.out)
    build_mode = args.mode
    if build_mode == "app":
        if not args.app:
            raise LedgerError("打包模式 init-run 必须提供 --app")
        app_path, _asar, build_hash = _app_asar(args.app)
        build_location = {"appPath": str(app_path)}
    else:
        if args.app:
            raise LedgerError("开发模式 init-run 不接受 --app")
        app_path = None
        build_hash = _dev_source_hash(project)
        build_location = {"buildRoot": str(project)}
    rules, journeys, release_suites, baseline_hashes = _parse_scope(project)
    runs_dir.mkdir(exist_ok=True)
    if _lstat(runs_dir) is None or stat.S_ISLNK(runs_dir.lstat().st_mode):
        raise LedgerError("无法安全建立 acceptance-runs 目录")
    try:
        run_dir.mkdir()
    except FileExistsError as exc:
        raise LedgerError(f"目标已存在，拒绝覆盖：{run_dir}") from exc

    try:
        for name in ("profile", "fixtures", "evidence"):
            (run_dir / name).mkdir()
        created = now_iso()
        marker: dict[str, Any] = {
            "schema": RUN_SCHEMA,
            "project": str(project),
            "runId": run_dir.name,
            "buildMode": build_mode,
            **build_location,
            "buildHash": build_hash,
            "buildEpoch": 0,
            "buildHistory": [{"epoch": 0, "mode": build_mode, **build_location, "buildHash": build_hash, "at": created}],
            "baselineHashes": baseline_hashes,
            "createdAt": created,
        }
        cases_obj = {
            "schema": CASES_SCHEMA,
            "groups": [
                {
                    "id": group["id"],
                    "title": group["title"],
                    "kind": group_kind,
                    "ruleIds": list(group["rules"]),
                }
                for group_kind, groups in (("journey", journeys), ("release-suite", release_suites))
                for group in groups
            ],
            "rules": [
                {
                    "id": row["id"],
                    "title": row["title"],
                    "kind": row["kind"],
                    "journeyIds": row["journeyIds"],
                    "sourceLine": row["sourceLine"],
                    "source": row["source"],
                    "decisionTitle": row.get("decisionTitle"),
                    "acceptance": row["acceptance"],
                "evidenceCases": row["evidenceCases"],
                    "coverageStatus": "pending_decomposition",
                    "plannedCaseIds": [],
                    "decompositionReviews": [],
                }
                for row in rules
            ],
            "cases": [],
        }
        (run_dir / "run.json").write_text(json.dumps(marker, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (run_dir / "cases.json").write_text(json.dumps(cases_obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (run_dir / "issues.json").write_text(
            json.dumps({"schema": ISSUES_SCHEMA, "issues": []}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (run_dir / "audit.jsonl").write_text("", encoding="utf-8")
        (run_dir / "REPORT.md").write_text("# Rambo 全量验收报告\n\n正在初始化报告。\n", encoding="utf-8")
        _append_audit(
            run_dir,
            "init_run",
            "coordinator",
            {
                "ruleCount": sum(row["kind"] == "rule" for row in rules),
                "journeyCount": len(journeys),
                "releaseSuiteCount": len(release_suites),
                "acceptanceScenarioCount": sum(len(row["acceptance"]["scenarioIds"]) for row in rules),
                "buildMode": build_mode,
                "buildHash": build_hash,
                "baselineHashes": baseline_hashes,
            },
        )
        _write_report(run_dir)
    except Exception:
        # Init creates a new, previously nonexistent output directory. If its
        # first write fails, remove only that incomplete directory.
        shutil.rmtree(run_dir, ignore_errors=True)
        raise
    print(f"已建立验收运行：{run_dir}")
    print(
        f"规则：{sum(row['kind'] == 'rule' for row in rules)}；"
        f"核心旅程：{len(journeys)}；发布套件：{len(release_suites)}；"
        f"规则场景：{sum(len(row['acceptance']['scenarioIds']) for row in rules)}"
    )
    return 0


def _load_run(run_value: str | Path) -> tuple[Path, dict[str, Any]]:
    run_dir = Path(run_value).expanduser()
    if not run_dir.is_absolute():
        run_dir = Path.cwd() / run_dir
    run_dir = Path(os.path.abspath(run_dir))
    _require_real_directory(run_dir, "运行目录")
    marker = _read_json(run_dir / "run.json", "run.json")
    if marker.get("schema") != RUN_SCHEMA:
        raise LedgerError(f"run.json schema不匹配，期望 {RUN_SCHEMA}")
    project = Path(str(marker.get("project", "")))
    try:
        project = project.resolve(strict=True)
    except (FileNotFoundError, OSError) as exc:
        raise LedgerError("run.json中的project目录不存在") from exc
    expected = project / "acceptance-runs" / str(marker.get("runId", ""))
    try:
        actual = run_dir.resolve(strict=True)
    except (FileNotFoundError, OSError) as exc:
        raise LedgerError("运行目录无法解析") from exc
    if actual != expected:
        raise LedgerError("运行目录不符合 project/acceptance-runs/<runId>，或路径经过符号链接")
    _require_real_directory(project / "acceptance-runs", "acceptance-runs目录")
    for name in ("profile", "fixtures", "evidence"):
        _require_real_directory(run_dir / name, name)
    if run_dir.name != marker.get("runId"):
        raise LedgerError("运行目录名称与run.json runId不一致")
    return run_dir, marker


def _ensure_baseline_current(marker: dict[str, Any]) -> dict[str, str]:
    project = Path(marker["project"])
    _decisions, _matrix, _catalog = _project_docs(project)
    current = {
        DECISIONS_REL: sha256_file(project / DECISIONS_REL),
        MATRIX_REL: sha256_file(project / MATRIX_REL),
        CATALOG_REL: sha256_file(project / CATALOG_REL),
    }
    if current != marker.get("baselineHashes"):
        raise LedgerError("决策或验收矩阵基准已变化；旧运行不可沿用，请用当前文档创建新run")
    return current


def _current_build_hash(marker: dict[str, Any]) -> str:
    mode = marker.get("buildMode", "app")
    if mode == "dev":
        project = Path(marker["project"]).resolve(strict=True)
        build_root_value = marker.get("buildRoot", str(project))
        build_root = Path(str(build_root_value)).resolve(strict=True)
        if build_root != project:
            raise LedgerError("开发构建根目录必须与run记录的project一致")
        return _dev_source_hash(build_root)
    if mode != "app":
        raise LedgerError(f"run.json中的buildMode无效：{mode}")
    app_path = marker.get("appPath")
    if not isinstance(app_path, str) or not app_path:
        raise LedgerError("打包构建缺少appPath")
    return _app_asar(app_path)[2]


def _ensure_registered_build_current(marker: dict[str, Any]) -> None:
    try:
        current = _current_build_hash(marker)
    except LedgerError as exc:
        raise LedgerError(f"无法读取当前构建；请先登记有效的 App 或开发模式构建：{exc}") from exc
    if current != marker.get("buildHash"):
        raise LedgerError("当前构建指纹已变化且尚未登记；请先运行 build --mode app/dev --actor coordinator")


def _load_cases(run_dir: Path) -> dict[str, Any]:
    obj = _read_json(run_dir / "cases.json", "cases.json")
    if obj.get("schema") not in (CASES_SCHEMA, LEGACY_CASES_SCHEMA):
        raise LedgerError("cases.json结构或schema无效")
    if not isinstance(obj.get("rules"), list) or not isinstance(obj.get("cases"), list):
        raise LedgerError("cases.json结构或schema无效")
    if obj["schema"] == CASES_SCHEMA:
        if not isinstance(obj.get("groups"), list) or not obj["groups"]:
            raise LedgerError("cases.json缺少groups")
        for rule in obj["rules"]:
            acceptance = rule.get("acceptance")
            if not isinstance(acceptance, dict) or not isinstance(acceptance.get("scenarioIds"), list):
                raise LedgerError(f"cases.json规则 {rule.get('id')} 缺少完整验收场景")
    return obj


def _load_issues(run_dir: Path) -> dict[str, Any]:
    obj = _read_json(run_dir / "issues.json", "issues.json")
    if obj.get("schema") != ISSUES_SCHEMA or not isinstance(obj.get("issues"), list):
        raise LedgerError("issues.json结构或schema无效")
    return obj


def _parse_input_json(value: str) -> dict[str, Any]:
    candidate = Path(value).expanduser()
    if not value.lstrip().startswith(("{", "[")) and candidate.is_file():
        try:
            text = candidate.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise LedgerError(f"无法读取JSON输入：{exc}") from exc
    else:
        text = value
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise LedgerError(f"--input不是有效JSON或可读文件：{exc}") from exc
    if not isinstance(parsed, dict):
        raise LedgerError("--input顶层必须是JSON对象")
    return parsed


def _machine_evidence(args: argparse.Namespace, run_dir: Path, marker: dict[str, Any]) -> dict[str, Any]:
    test_id = _nonempty_text(args.test_id, "test-id")
    test_command = _nonempty_text(args.test_command, "test-command")
    suite_hash = _nonempty_text(args.suite_hash, "suite-hash")
    if not re.fullmatch(r"[0-9a-f]{64}", suite_hash):
        raise LedgerError("suite-hash必须是64位小写SHA-256")
    evidence = _resolve_evidence(run_dir, args.evidence)
    return {
        "testId": test_id,
        "testCommand": test_command,
        "suiteHash": suite_hash,
        "buildEpoch": marker["buildEpoch"],
        "buildHash": marker["buildHash"],
        "evidence": evidence,
    }


def _nonempty_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LedgerError(f"{label}必须是非空文本")
    return value.strip()


def _text_list(value: Any, label: str, *, allow_empty: bool = False) -> list[str]:
    if not isinstance(value, list) or (not allow_empty and not value):
        qualifier = "数组" if allow_empty else "非空数组"
        raise LedgerError(f"{label}必须是{qualifier}文本")
    result = []
    for index, item in enumerate(value):
        result.append(_nonempty_text(item, f"{label}[{index}]"))
    return result


def _case_map(cases_obj: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for case in cases_obj["cases"]:
        case_id = case.get("id")
        if not isinstance(case_id, str) or case_id in result:
            raise LedgerError("cases.json存在无效或重复子case编号")
        result[case_id] = case
    return result


def _plan(args: argparse.Namespace) -> int:
    _check_actor(args.actor, "coordinator", "plan")
    run_dir, marker = _load_run(args.run)
    _ensure_baseline_current(marker)
    cases_obj = _load_cases(run_dir)
    if cases_obj.get("schema") != CASES_SCHEMA:
        raise LedgerError("旧版 cases.v1 仍可生成历史报告，但不能再追加案例；请用当前决策与目录创建新 run")
    input_obj = _parse_input_json(args.input)
    rules_by_id = {rule["id"]: rule for rule in cases_obj["rules"]}
    existing = _case_map(cases_obj)

    raw_cases = input_obj.get("cases")
    if not isinstance(raw_cases, list):
        raise LedgerError("plan JSON必须包含cases数组")
    new_cases: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw in enumerate(raw_cases):
        if not isinstance(raw, dict):
            raise LedgerError(f"cases[{index}]必须是对象")
        case_id = _nonempty_text(raw.get("id"), f"cases[{index}].id")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", case_id):
            raise LedgerError(f"子case编号格式无效：{case_id}")
        if case_id in seen_ids or case_id in existing:
            raise LedgerError(f"子case编号重复，拒绝覆盖历史：{case_id}")
        seen_ids.add(case_id)
        raw_ids = raw.get("ruleIds")
        if not isinstance(raw_ids, list) or not raw_ids:
            raise LedgerError(f"{case_id}.ruleIds必须是非空数组")
        rule_ids = [_nonempty_text(item, f"{case_id}.ruleIds") for item in raw_ids]
        if len(set(rule_ids)) != len(rule_ids):
            raise LedgerError(f"{case_id}.ruleIds存在重复编号")
        unknown = [item for item in rule_ids if item not in rules_by_id]
        if unknown:
            raise LedgerError(f"{case_id}引用未知矩阵编号：{', '.join(unknown)}")
        coverage = raw.get("coverage")
        if not isinstance(coverage, dict) or set(coverage) != set(rule_ids):
            raise LedgerError(f"{case_id}.coverage必须且只能为每个ruleId提供一条说明")
        normalized_coverage = {rid: _nonempty_text(coverage[rid], f"{case_id}.coverage.{rid}") for rid in rule_ids}
        preconditions = raw.get("preconditions")
        if isinstance(preconditions, str):
            preconditions = [preconditions] if preconditions.strip() else []
        preconditions = _text_list(preconditions, f"{case_id}.preconditions", allow_empty=True)
        steps = raw.get("steps")
        if isinstance(steps, str):
            steps = [steps]
        steps = _text_list(steps, f"{case_id}.steps")
        expected = raw.get("expected")
        if isinstance(expected, str):
            expected = [expected]
        expected = _text_list(expected, f"{case_id}.expected")
        new_cases.append(
            {
                "id": case_id,
                "ruleIds": rule_ids,
                "coverage": normalized_coverage,
                "kind": _nonempty_text(raw.get("kind"), f"{case_id}.kind"),
                "preconditions": preconditions,
                "steps": steps,
                "expected": expected,
                "plannedAt": now_iso(),
                "plannedBy": "coordinator",
                "events": [],
            }
        )

    raw_review = input_obj.get("coverageReview", {})
    if not isinstance(raw_review, dict):
        raise LedgerError("coverageReview必须是按规则编号索引的JSON对象")
    unknown_reviews = sorted(set(raw_review) - set(rules_by_id))
    if unknown_reviews:
        raise LedgerError("coverageReview引用未知矩阵编号：" + ", ".join(unknown_reviews))
    all_case_map = dict(existing)
    all_case_map.update({case["id"]: case for case in new_cases})
    review_entries: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for rule_id, review in raw_review.items():
        if not isinstance(review, dict) or not isinstance(review.get("complete"), bool):
            raise LedgerError(f"coverageReview.{rule_id}必须含布尔complete")
        reason = _nonempty_text(review.get("reason"), f"coverageReview.{rule_id}.reason")
        attached = [case for case in all_case_map.values() if rule_id in case.get("ruleIds", [])]
        if review["complete"] and not attached:
            raise LedgerError(f"{rule_id}不能确认拆解complete：尚无对应子case")
        if review["complete"] and any(rule_id not in case.get("coverage", {}) for case in attached):
            raise LedgerError(f"{rule_id}不能确认拆解complete：存在缺少逐规则coverage说明的子case")
        scenario_ids = rules_by_id[rule_id]["acceptance"]["scenarioIds"]
        covered_scenario_ids = review.get("scenarioIds")
        if (
            not isinstance(covered_scenario_ids, list)
            or not covered_scenario_ids
            or len(set(covered_scenario_ids)) != len(covered_scenario_ids)
            or any(not isinstance(item, str) for item in covered_scenario_ids)
        ):
            raise LedgerError(f"coverageReview.{rule_id}.scenarioIds必须是非空且不重复的文本数组")
        unknown_scenarios = sorted(set(covered_scenario_ids) - set(scenario_ids))
        if unknown_scenarios:
            raise LedgerError(
                f"coverageReview.{rule_id}引用未知验收场景：" + ", ".join(unknown_scenarios)
            )
        if review["complete"] and set(covered_scenario_ids) != set(scenario_ids):
            raise LedgerError(
                f"{rule_id}不能确认拆解complete：必须覆盖全部验收场景 "
                + ", ".join(scenario_ids)
            )
        review_entries.append(
            (
                rules_by_id[rule_id],
                {
                    "complete": review["complete"],
                    "reason": reason,
                    "scenarioIds": covered_scenario_ids,
                    "confirmedBy": "coordinator",
                    "confirmedAt": now_iso(),
                },
            )
        )

    cases_obj["cases"].extend(new_cases)
    for case in new_cases:
        for rule_id in case["ruleIds"]:
            rules_by_id[rule_id].setdefault("plannedCaseIds", []).append(case["id"])
    for rule, review in review_entries:
        rule.setdefault("decompositionReviews", []).append(review)
        rule["coverageStatus"] = "complete" if review["complete"] else "incomplete"
    audit_id = _append_audit(
        run_dir,
        "plan",
        "coordinator",
        {
            "caseIds": [case["id"] for case in new_cases],
            "coverageReview": {rule["id"]: review["complete"] for rule, review in review_entries},
        },
    )
    for case in new_cases:
        case["plannedEventId"] = audit_id
    for rule, _review in review_entries:
        if rule.get("decompositionReviews"):
            rule["decompositionReviews"][-1]["auditEventId"] = audit_id
    _write_json(run_dir / "cases.json", cases_obj)
    _write_report(run_dir)
    print(f"已追加 {len(new_cases)} 个子case，确认拆解 {sum(review['complete'] for _, review in review_entries)} 条")
    return 0


def _resolve_evidence(run_dir: Path, supplied_values: Iterable[str]) -> list[dict[str, Any]]:
    values = list(supplied_values)
    if not values:
        raise LedgerError("至少需要一份真实证据文件")
    roots = [run_dir / "evidence", run_dir / "fixtures"]
    evidence: list[dict[str, Any]] = []
    seen: set[str] = set()
    for supplied in values:
        raw = Path(supplied).expanduser()
        if ".." in raw.parts:
            raise LedgerError(f"证据路径不能包含 ..：{supplied}")
        path = raw if raw.is_absolute() else run_dir / raw
        path = Path(os.path.abspath(path))
        matching_root: Path | None = None
        for root in roots:
            try:
                if os.path.commonpath((str(path), str(root))) == str(root):
                    matching_root = root
                    break
            except ValueError:
                continue
        if matching_root is None:
            raise LedgerError(f"证据必须位于运行目录的evidence或fixtures中：{supplied}")
        relative = path.relative_to(matching_root)
        current = matching_root
        for part in ("", *relative.parts):
            if part:
                current = current / part
            info = _lstat(current)
            if info is None:
                raise LedgerError(f"证据文件不存在：{current}")
            if stat.S_ISLNK(info.st_mode):
                raise LedgerError(f"证据路径不能经过符号链接：{current}")
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise LedgerError(f"证据必须是普通文件，不能是目录：{path}")
        rel_run = path.relative_to(run_dir).as_posix()
        if rel_run in seen:
            continue
        seen.add(rel_run)
        evidence.append({"path": rel_run, "sha256": sha256_file(path), "size": info.st_size})
    return evidence


def _case_for_update(cases_obj: dict[str, Any], case_id: str) -> dict[str, Any]:
    case = _case_map(cases_obj).get(case_id)
    if case is None:
        raise LedgerError(f"找不到子case：{case_id}")
    return case


def _record(args: argparse.Namespace) -> int:
    _check_actor(args.actor, "tester", "record")
    run_dir, marker = _load_run(args.run)
    _ensure_baseline_current(marker)
    _ensure_registered_build_current(marker)
    cases_obj = _load_cases(run_dir)
    case = _case_for_update(cases_obj, args.case)
    evidence = _resolve_evidence(run_dir, args.evidence)
    actual = _nonempty_text(args.actual, "actual")
    event = {
        "eventId": uuid.uuid4().hex,
        "type": "observation",
        "recordedAt": now_iso(),
        "actor": "tester",
        "result": args.result,
        "actual": actual,
        "evidence": evidence,
        "buildEpoch": marker["buildEpoch"],
        "buildHash": marker["buildHash"],
    }
    audit_id = _append_audit(
        run_dir,
        "record",
        "tester",
        {"caseId": args.case, "result": args.result, "evidence": evidence},
    )
    event["auditEventId"] = audit_id
    case.setdefault("events", []).append(event)
    _write_json(run_dir / "cases.json", cases_obj)
    _write_report(run_dir)
    print(f"已记录 {args.case} 的测试观察；这不会自动通过验收")
    return 0


def _verify(args: argparse.Namespace) -> int:
    _check_actor(args.actor, "coordinator", "verify")
    run_dir, marker = _load_run(args.run)
    _ensure_baseline_current(marker)
    _ensure_registered_build_current(marker)
    cases_obj = _load_cases(run_dir)
    case = _case_for_update(cases_obj, args.case)
    observations = [
        event
        for event in case.get("events", [])
        if event.get("type") == "observation" and event.get("buildEpoch") == marker["buildEpoch"]
    ]
    if not observations:
        raise LedgerError("verify要求当前buildEpoch已有tester record观察记录")
    latest_observation = observations[-1]
    evidence = _resolve_evidence(run_dir, args.evidence)
    actual = _nonempty_text(args.actual, "actual")
    event = {
        "eventId": uuid.uuid4().hex,
        "type": "verification",
        "verifiedAt": now_iso(),
        "actor": "coordinator",
        "result": args.result,
        "actual": actual,
        "evidence": evidence,
        "buildEpoch": marker["buildEpoch"],
        "buildHash": marker["buildHash"],
        "observationEventIds": [latest_observation["eventId"]],
    }
    audit_id = _append_audit(
        run_dir,
        "verify",
        "coordinator",
        {"caseId": args.case, "result": args.result, "buildEpoch": marker["buildEpoch"], "evidence": evidence},
    )
    event["auditEventId"] = audit_id
    case.setdefault("events", []).append(event)
    _write_json(run_dir / "cases.json", cases_obj)
    _write_report(run_dir)
    print(f"已由coordinator复验 {args.case}：{STATUS_ZH[args.result]}")
    return 0


def _machine_verify(args: argparse.Namespace) -> int:
    _check_actor(args.actor, "coordinator", "machine-verify")
    if args.result != "pass":
        raise LedgerError("machine-verify只接受确定性自动测试的pass；失败请用verify保留现场")
    run_dir, marker = _load_run(args.run)
    _ensure_baseline_current(marker)
    _ensure_registered_build_current(marker)
    cases_obj = _load_cases(run_dir)
    case = _case_for_update(cases_obj, args.case)
    machine = _machine_evidence(args, run_dir, marker)
    event = {
        "eventId": uuid.uuid4().hex,
        "type": "machine_verification",
        "verifiedAt": now_iso(),
        "actor": "coordinator",
        "result": "pass",
        "actual": _nonempty_text(args.actual, "actual"),
        **machine,
    }
    audit_id = _append_audit(
        run_dir,
        "machine-verify",
        "coordinator",
        {
            "caseId": args.case,
            "result": "pass",
            "buildEpoch": marker["buildEpoch"],
            "testId": machine["testId"],
            "testCommand": machine["testCommand"],
            "suiteHash": machine["suiteHash"],
            "evidence": machine["evidence"],
        },
    )
    event["auditEventId"] = audit_id
    case.setdefault("events", []).append(event)
    _write_json(run_dir / "cases.json", cases_obj)
    _write_report(run_dir)
    print(f"已登记确定性机器证据并判定 {args.case}：通过")
    return 0


def _new_issue_id(issues_obj: dict[str, Any]) -> str:
    return f"ISSUE-{len(issues_obj['issues']) + 1:04d}"


def _issue(args: argparse.Namespace) -> int:
    _check_actor(args.actor, "tester", "issue")
    run_dir, marker = _load_run(args.run)
    _ensure_baseline_current(marker)
    _ensure_registered_build_current(marker)
    cases_obj = _load_cases(run_dir)
    case = _case_for_update(cases_obj, args.case)
    issues_obj = _load_issues(run_dir)
    input_obj = _parse_input_json(args.input)
    reproduction = input_obj.get("reproduction", input_obj.get("steps"))
    reproduction = _text_list(reproduction, "reproduction")
    expected = _nonempty_text(input_obj.get("expected"), "expected")
    actual = _nonempty_text(input_obj.get("actual"), "actual")
    severity = _nonempty_text(input_obj.get("severity"), "severity").lower()
    if severity not in ("low", "medium", "high", "critical"):
        raise LedgerError("severity必须是low、medium、high或critical")
    raw_evidence = input_obj.get("evidence")
    if not isinstance(raw_evidence, list):
        raise LedgerError("issue input必须含evidence路径数组")
    evidence = _resolve_evidence(run_dir, [str(item) for item in raw_evidence])
    issue_id = _nonempty_text(input_obj.get("id", _new_issue_id(issues_obj)), "issue.id")
    if any(issue.get("id") == issue_id for issue in issues_obj["issues"]):
        raise LedgerError(f"问题编号已存在：{issue_id}")
    title = _nonempty_text(input_obj.get("title", f"{args.case}验收问题"), "title")
    issue = {
        "id": issue_id,
        "caseId": args.case,
        "ruleIds": case["ruleIds"],
        "title": title,
        "severity": severity,
        "reproduction": reproduction,
        "expected": expected,
        "actual": actual,
        "evidence": evidence,
        "openedAt": now_iso(),
        "openedBy": "tester",
        "buildEpoch": marker["buildEpoch"],
        "buildHash": marker["buildHash"],
        "fixes": [],
    }
    audit_id = _append_audit(
        run_dir,
        "issue",
        "tester",
        {"issueId": issue_id, "caseId": args.case, "severity": severity, "evidence": evidence},
    )
    issue["auditEventId"] = audit_id
    issues_obj["issues"].append(issue)
    case.setdefault("events", []).append(
        {
            "eventId": uuid.uuid4().hex,
            "auditEventId": audit_id,
            "type": "issue",
            "recordedAt": issue["openedAt"],
            "actor": "tester",
            "result": "fail",
            "actual": actual,
            "evidence": evidence,
            "issueId": issue_id,
            "buildEpoch": marker["buildEpoch"],
            "buildHash": marker["buildHash"],
        }
    )
    _write_json(run_dir / "issues.json", issues_obj)
    _write_json(run_dir / "cases.json", cases_obj)
    _write_report(run_dir)
    print(f"已登记问题 {issue_id}，关联 {args.case}")
    return 0


def _fix(args: argparse.Namespace) -> int:
    _check_actor(args.actor, "fixer", "fix")
    run_dir, marker = _load_run(args.run)
    _ensure_baseline_current(marker)
    issues_obj = _load_issues(run_dir)
    issue = next((item for item in issues_obj["issues"] if item.get("id") == args.issue), None)
    if issue is None:
        raise LedgerError(f"找不到问题：{args.issue}")
    input_obj = _parse_input_json(args.input)
    files = _text_list(input_obj.get("modifiedFiles"), "modifiedFiles")
    explanation = _nonempty_text(input_obj.get("explanation"), "explanation")
    new_build_hash = _nonempty_text(input_obj.get("newBuildHash"), "newBuildHash").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", new_build_hash):
        raise LedgerError("newBuildHash必须是64位SHA-256十六进制值")
    fix_entry = {
        "recordedAt": now_iso(),
        "recordedBy": "fixer",
        "modifiedFiles": files,
        "explanation": explanation,
        "newBuildHash": new_build_hash,
    }
    audit_id = _append_audit(
        run_dir,
        "fix",
        "fixer",
        {"issueId": args.issue, "modifiedFiles": files, "newBuildHash": new_build_hash},
    )
    fix_entry["auditEventId"] = audit_id
    issue.setdefault("fixes", []).append(fix_entry)
    _write_json(run_dir / "issues.json", issues_obj)
    _write_report(run_dir)
    print(f"已追加 {args.issue} 的修复记录；修复者不能验收通过")
    return 0


def _build(args: argparse.Namespace) -> int:
    _check_actor(args.actor, "coordinator", "build")
    run_dir, marker = _load_run(args.run)
    _ensure_baseline_current(marker)
    mode = args.mode or ("app" if args.app else marker.get("buildMode", "app"))
    if mode == "app":
        app_value = args.app or marker.get("appPath")
        if not isinstance(app_value, str) or not app_value:
            raise LedgerError("打包模式 build 必须提供 --app")
        app_path, _asar, build_hash = _app_asar(app_value)
        build_location = {"appPath": str(app_path)}
    elif mode == "dev":
        if args.app:
            raise LedgerError("开发模式 build 不接受 --app")
        project = Path(marker["project"]).resolve(strict=True)
        app_path = None
        build_hash = _dev_source_hash(project)
        build_location = {"buildRoot": str(project)}
    else:
        raise LedgerError(f"未知构建模式：{mode}")
    old_hash = marker.get("buildHash")
    epoch = int(marker.get("buildEpoch", 0)) + 1
    at = now_iso()
    history = marker.setdefault("buildHistory", [])
    history.append({"epoch": epoch, "mode": mode, **build_location, "buildHash": build_hash, "at": at})
    marker["buildMode"] = mode
    if mode == "app":
        marker["appPath"] = build_location["appPath"]
        marker.pop("buildRoot", None)
    else:
        marker["buildRoot"] = build_location["buildRoot"]
        marker.pop("appPath", None)
    marker["buildHash"] = build_hash
    marker["buildEpoch"] = epoch
    audit_id = _append_audit(
        run_dir,
        "build",
        "coordinator",
        {"mode": mode, "oldBuildHash": old_hash, "buildHash": build_hash, "buildEpoch": epoch, "invalidatesPriorVerifications": True},
    )
    marker["lastBuildAuditEventId"] = audit_id
    _write_json(run_dir / "run.json", marker)
    _write_report(run_dir)
    label = "开发模式源码与运行时指纹" if mode == "dev" else "app.asar"
    print(f"已登记{label} epoch={epoch} sha256={build_hash}；旧复验历史保留且不再计为当前通过")
    return 0


def _check_build(args: argparse.Namespace) -> int:
    run_dir, marker = _load_run(args.run)
    _ensure_baseline_current(marker)
    try:
        current_hash = _current_build_hash(marker)
    except LedgerError as exc:
        raise LedgerError(f"无法读取当前构建：{exc}") from exc
    if current_hash != marker.get("buildHash"):
        raise LedgerError("当前构建指纹已变化且尚未登记；请先运行 build --actor coordinator")
    print(json.dumps({
        "runId": marker["runId"],
        "mode": marker.get("buildMode", "app"),
        "buildHash": current_hash,
        "buildEpoch": marker["buildEpoch"],
        "buildRoot": marker.get("buildRoot"),
        "appPath": marker.get("appPath"),
        "runPath": str(run_dir),
    }, ensure_ascii=False))
    return 0


def _latest_review(rule: dict[str, Any]) -> dict[str, Any] | None:
    reviews = rule.get("decompositionReviews", [])
    return reviews[-1] if reviews else None


def _latest_event(case: dict[str, Any]) -> dict[str, Any] | None:
    events = case.get("events", [])
    return events[-1] if events else None


def _recorded_evidence_errors(run_dir: Path, evidence: Any) -> list[str]:
    """Recheck original paths and hashes without rewriting the stored evidence record."""
    if not isinstance(evidence, list) or not evidence:
        return ["未登记证据"]
    errors: list[str] = []
    for item in evidence:
        if not isinstance(item, dict):
            errors.append("证据记录格式无效")
            continue
        recorded_path = item.get("path")
        recorded_hash = item.get("sha256")
        label = str(recorded_path or "<路径缺失>")
        if not isinstance(recorded_path, str):
            errors.append(f"{label}：登记路径无效")
            continue
        relative = Path(recorded_path)
        if relative.is_absolute() or ".." in relative.parts:
            errors.append(f"{label}：登记路径越界")
            continue
        if not (relative.parts and relative.parts[0] in ("evidence", "fixtures")):
            errors.append(f"{label}：登记路径不在evidence或fixtures内")
            continue
        if not isinstance(recorded_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", recorded_hash):
            errors.append(f"{label}：登记SHA-256无效")
            continue
        try:
            current = _resolve_evidence(run_dir, [recorded_path])[0]
        except (LedgerError, OSError) as exc:
            errors.append(f"{label}：{exc}")
            continue
        if current["sha256"] != recorded_hash:
            errors.append(
                f"{label}：SHA-256不匹配（登记 {recorded_hash}，当前 {current['sha256']}）"
            )
        elif item.get("size") != current["size"]:
            errors.append(f"{label}：文件大小与登记值不匹配")
    return errors


def _current_case_evidence_errors(case: dict[str, Any], run_dir: Path) -> list[str]:
    event = _latest_event(case)
    if event is None:
        return []
    relevant_events = [event]
    if event.get("type") == "verification":
        by_id = {item.get("eventId"): item for item in case.get("events", [])}
        for observation_id in event.get("observationEventIds", []):
            observation = by_id.get(observation_id)
            if observation is None:
                return [f"verify关联的tester观察记录缺失：{observation_id}"]
            relevant_events.append(observation)
    errors: list[str] = []
    seen_events: set[str] = set()
    for evidence_event in relevant_events:
        event_id = str(evidence_event.get("eventId", ""))
        if event_id in seen_events:
            continue
        seen_events.add(event_id)
        errors.extend(_recorded_evidence_errors(run_dir, evidence_event.get("evidence")))
    return list(dict.fromkeys(errors))


def _case_status(
    case: dict[str, Any],
    marker: dict[str, Any],
    runtime: dict[str, Any],
    run_dir: Path,
) -> tuple[str, str]:
    event = _latest_event(case)
    if event is None:
        return "not_run", "尚无测试记录"
    evidence_errors = _current_case_evidence_errors(case, run_dir)
    if evidence_errors:
        return "blocked", "证据无效：" + "；".join(evidence_errors)
    if not runtime["baselineCurrent"]:
        return "not_run", "产品决策或验收矩阵基准变化，旧复验不可复用"
    if not runtime["buildCurrent"]:
        return "not_run", "登记构建指纹变化或不可读，旧复验不可复用"
    if event.get("buildEpoch") != marker.get("buildEpoch") or event.get("buildHash") != marker.get("buildHash"):
        return "not_run", "记录来自旧构建，需重新测试和复验"
    if event.get("type") == "verification":
        return event["result"], "coordinator复验"
    if event.get("type") == "machine_verification":
        return event.get("result", "not_run"), "确定性机器证据"
    if event.get("type") == "issue":
        return "fail", f"存在未完成复验的问题 {event.get('issueId', '')}".strip()
    observed = event.get("result", "not_run")
    return "not_run", f"tester观察为{STATUS_ZH.get(observed, observed)}，等待coordinator复验"


def _issue_status(
    issue: dict[str, Any],
    case: dict[str, Any] | None,
    marker: dict[str, Any],
    run_dir: Path,
) -> str:
    evidence_errors = _recorded_evidence_errors(run_dir, issue.get("evidence"))
    if evidence_errors:
        return "证据无效：" + "；".join(evidence_errors)
    if case is not None:
        case_evidence_errors = _current_case_evidence_errors(case, run_dir)
        if case_evidence_errors:
            return "关联case证据无效：" + "；".join(case_evidence_errors)
    fixes = issue.get("fixes", [])
    if not fixes:
        return "未修复"
    if case is None:
        return "已提交修复，缺少复验"
    latest = _latest_event(case)
    if not latest or latest.get("type") != "verification" or latest.get("result") != "pass":
        return "已提交修复，待复验"
    fix = fixes[-1]
    if (
        latest.get("buildEpoch") == marker.get("buildEpoch")
        and latest.get("buildEpoch", 0) > issue.get("buildEpoch", 0)
        and latest.get("buildHash") == marker.get("buildHash")
        and latest.get("buildHash") == fix.get("newBuildHash")
        and latest.get("verifiedAt", "") > fix.get("recordedAt", "")
    ):
        return "复验通过"
    return "已提交修复，待新构建复验"


def _runtime_health(run_dir: Path, marker: dict[str, Any]) -> dict[str, Any]:
    project = Path(marker["project"])
    try:
        _decisions, _matrix, _catalog = _project_docs(project)
        hashes = {
            path: sha256_file(project / path)
            for path in marker.get("baselineHashes", {})
        }
        baseline_current = hashes == marker.get("baselineHashes")
        baseline_error = None
    except LedgerError as exc:
        hashes = {}
        baseline_current = False
        baseline_error = str(exc)
    try:
        actual_hash = _current_build_hash(marker)
        build_current = actual_hash == marker.get("buildHash")
        build_error = None
    except LedgerError as exc:
        actual_hash = None
        build_current = False
        build_error = str(exc)
    return {
        "baselineCurrent": baseline_current,
        "baselineHashes": hashes,
        "baselineError": baseline_error,
        "buildCurrent": build_current,
        "actualBuildHash": actual_hash,
        "buildError": build_error,
    }


def _derive_report(
    cases_obj: dict[str, Any],
    issues_obj: dict[str, Any],
    marker: dict[str, Any],
    runtime: dict[str, Any],
    run_dir: Path,
) -> dict[str, Any]:
    cases = _case_map(cases_obj)
    statuses: dict[str, tuple[str, str]] = {
        case_id: _case_status(case, marker, runtime, run_dir) for case_id, case in cases.items()
    }
    rules = []
    for rule in cases_obj["rules"]:
        review = _latest_review(rule)
        is_complete = bool(review and review.get("complete") is True)
        acceptance_ids = rule.get("acceptance", {}).get("scenarioIds", [])
        reviewed_ids = review.get("scenarioIds", []) if review else []
        has_scenario_contract = bool(acceptance_ids)
        covers_all_scenarios = has_scenario_contract and set(reviewed_ids) == set(acceptance_ids)
        linked = [case for case in cases_obj["cases"] if rule["id"] in case.get("ruleIds", [])]
        catalog_case_ids = {
            evidence["id"]
            for evidence in rule.get("evidenceCases", [])
            if evidence.get("status") == "implemented"
        }
        missing_catalog_cases = sorted(catalog_case_ids - {case["id"] for case in linked})
        if has_scenario_contract and not covers_all_scenarios:
            status = "not_run"
            detail = f"规则场景覆盖不完整（{len(set(reviewed_ids) & set(acceptance_ids))}/{len(acceptance_ids)}）"
        elif not is_complete:
            status = "not_run"
            detail = "待coordinator确认拆解complete" if review is None else "拆解未确认complete"
        elif missing_catalog_cases:
            status = "not_run"
            detail = "目录中的已实现证据尚未纳入 run：" + ", ".join(missing_catalog_cases)
        elif not linked:
            status = "not_run"
            detail = "拆解complete但没有子case"
        else:
            child_states = [statuses[case["id"]][0] for case in linked]
            if all(value == "pass" for value in child_states):
                status = "pass"
                detail = "所有已规划子case均由当前构建的有效证据通过"
            elif "fail" in child_states:
                status = "fail"
                detail = "至少一个子case失败或存在未闭环问题"
            elif "blocked" in child_states:
                status = "blocked"
                detail = "至少一个子case受阻"
            elif "clarify" in child_states:
                status = "clarify"
                detail = "至少一个子case待澄清"
            else:
                status = "not_run"
                detail = "至少一个子case未执行或等待coordinator复验"
        rules.append({"rule": rule, "review": review, "cases": linked, "status": status, "detail": detail})

    issue_by_id = {item.get("id"): item for item in issues_obj["issues"]}
    issue_rows = []
    for issue in issues_obj["issues"]:
        case = cases.get(issue.get("caseId"))
        issue_rows.append({"issue": issue, "status": _issue_status(issue, case, marker, run_dir)})

    all_pass = (
        runtime["baselineCurrent"]
        and runtime["buildCurrent"]
        and bool(rules)
        and all(entry["status"] == "pass" for entry in rules)
        and all(row["status"] == "复验通过" for row in issue_rows)
    )
    return {
        "rules": rules,
        "caseStatuses": statuses,
        "issues": issue_rows,
        "allPass": all_pass,
    }


def _md_cell(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def _write_report(run_dir: Path) -> None:
    marker = _read_json(run_dir / "run.json", "run.json")
    cases_obj = _load_cases(run_dir)
    issues_obj = _load_issues(run_dir)
    runtime = _runtime_health(run_dir, marker)
    derived = _derive_report(cases_obj, issues_obj, marker, runtime, run_dir)
    total_cases = len(cases_obj["cases"])
    passed_cases = sum(status == "pass" for status, _ in derived["caseStatuses"].values())
    groups = cases_obj.get("groups", [])
    legacy_flow_count = sum(entry["rule"]["kind"] == "flow" for entry in derived["rules"])
    groups_supported = cases_obj.get("schema") == CASES_SCHEMA

    lines = [
        "# Rambo 全量验收报告",
        "",
        "> 本报告是软件验收记录，不是产品实际执行的证明。没有真实、可读取且位于本run内的证据时，不能通过。测试数据、夹具和观察记录均不替代产品实际运行。",
        "> actor参数仅为流程护栏，不构成身份认证或安全授权。本脚本不启动应用、不访问认证、不控制电脑。",
        "",
        f"- Run：`{marker['runId']}`",
        f"- 生成时间：{now_iso()}",
        f"- 执行模式：`{marker.get('buildMode', 'app')}`",
        f"- 应用/开发根目录：`{marker.get('appPath') or marker.get('buildRoot') or '未登记'}`",
        f"- 登记构建 SHA-256：`{marker['buildHash']}`（epoch {marker['buildEpoch']}）",
        f"- 当前构建指纹：`{runtime['actualBuildHash'] or '不可读取'}`",
        f"- 全量通过：**{'是' if derived['allPass'] else '否'}**",
        f"- 子case：{passed_cases}/{total_cases} 个由coordinator在当前构建复验通过",
        f"- 规则：{sum(item['status'] == 'pass' for item in derived['rules'])}/{len(derived['rules'])} 通过",
        f"- 规则场景：{sum(len(entry['rule'].get('acceptance', {}).get('scenarioIds', [])) for entry in derived['rules'])} 个；由完整规则证据审核",
        f"- 局部证据案例：{passed_cases}/{total_cases} 个在当前构建有效通过",
        "",
        "## 基准与构建",
        "",
        "| 基准 | run基准 SHA-256 | 当前 SHA-256 | 状态 |",
        "| --- | --- | --- | --- |",
    ]
    for key, label in ((DECISIONS_REL, "产品决策"), (MATRIX_REL, "验收矩阵"), (CATALOG_REL, "测试目录")):
        current = runtime["baselineHashes"].get(key, "不可读取")
        baseline = marker.get("baselineHashes", {}).get(key, "缺失")
        lines.append(f"| {label} | `{baseline}` | `{current}` | {'一致' if current == baseline else '变化/不可用'} |")
    lines.extend(["", "- 构建状态：" + ("与登记hash一致" if runtime["buildCurrent"] else "不一致或不可读取，旧复验不能计为通过"), ""])
    if not runtime["baselineCurrent"]:
        lines.append(f"- 基准错误：{runtime['baselineError'] or '文档内容已变化；请建立新run'}")
    if not runtime["buildCurrent"]:
        lines.append(f"- 构建错误：{runtime['buildError'] or '当前构建输入已变化；由coordinator登记新构建'}")
    if groups_supported:
        lines.extend(
            [
                "",
                "## 核心旅程与发布套件",
                "",
                "| 分组 | 规则通过 | 规则总数 | 状态 | 判定依据 |",
                "| --- | --- | --- | --- | --- |",
            ]
        )
        entries_by_rule = {entry["rule"]["id"]: entry for entry in derived["rules"]}
        for group in groups:
            member_ids = [rule_id for rule_id in group["ruleIds"] if rule_id in entries_by_rule]
            passed = sum(entries_by_rule[rule_id]["status"] == "pass" for rule_id in member_ids)
            if passed == len(member_ids) and member_ids:
                group_status = "pass"
                group_detail = "该分组的全部规则均有当前构建有效证据"
            elif any(entries_by_rule[rule_id]["status"] == "fail" for rule_id in member_ids):
                group_status = "fail"
                group_detail = "至少一条规则失败"
            elif any(entries_by_rule[rule_id]["status"] == "blocked" for rule_id in member_ids):
                group_status = "blocked"
                group_detail = "至少一条规则受阻"
            elif any(entries_by_rule[rule_id]["status"] == "clarify" for rule_id in member_ids):
                group_status = "clarify"
                group_detail = "至少一条规则待澄清"
            else:
                group_status = "not_run"
                group_detail = "仍有规则未执行、待复验或缺少完整场景证据"
            lines.append(
                f"| {_md_cell(group['id'])} {_md_cell(group['title'])} | {passed}/{len(member_ids)} | "
                f"{len(member_ids)} | {STATUS_ZH[group_status]} | {_md_cell(group_detail)} |"
            )

    lines.extend(
        [
            "",
            "## 决策规则覆盖",
            "",
            "| 编号 | 验收对象 | 分组 | 规则场景 | 拆解确认 | 局部证据案例 | 状态 | 判定依据 |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
    )
    for entry in derived["rules"]:
        rule = entry["rule"]
        review = entry["review"]
        decomposition = "complete" if review and review.get("complete") else "待确认/未完成"
        child_parts = []
        for case in entry["cases"]:
            child_status, child_detail = derived["caseStatuses"][case["id"]]
            child_parts.append(f"{case['id']}（{STATUS_ZH[child_status]}：{child_detail}）")
        review_scenarios = review.get("scenarioIds", []) if review else []
        scenario_ids = rule.get("acceptance", {}).get("scenarioIds", [])
        scenario_text = f"{len(review_scenarios)}/{len(scenario_ids)}" if scenario_ids else "旧版无记录"
        evidence_cases = rule.get("evidenceCases", [])
        executed_cases = [
            case_id
            for case_id in (case["id"] for case in evidence_cases)
            if case_id in derived["caseStatuses"] and derived["caseStatuses"][case_id][0] == "pass"
        ]
        evidence_summary = (
            f"目录 {len(evidence_cases)} 项；当前通过 {len(executed_cases)} 项"
            if evidence_cases
            else "无目录案例"
        )
        lines.append(
            "| "
            + " | ".join(
                _md_cell(value)
                for value in (
                    rule["id"],
                    rule["title"],
                    ", ".join(rule.get("journeyIds", [])) or "旧版",
                    scenario_text,
                    decomposition,
                    evidence_summary,
                    STATUS_ZH[entry["status"]],
                    entry["detail"],
                )
            )
            + " |"
        )
    if legacy_flow_count:
        lines.extend(
            [
                "",
                f"> 本 run 为旧版 schema，仍保留 {legacy_flow_count} 条历史 E 流程；新 run 使用 J1–J4 和 7 个发布套件，不再创建 E 流程义务。",
            ]
        )
    lines.extend(["", "## 子case与问题状态", ""])
    if not cases_obj["cases"]:
        lines.append("尚未规划子case；矩阵每一行目前仅为待拆解覆盖记录。")
    else:
        lines.extend(["| 子case | 关联规则 | 类型 | 状态 | 最新记录 | 证据路径及SHA-256 |", "| --- | --- | --- | --- | --- | --- |"])
        for case in cases_obj["cases"]:
            status, detail = derived["caseStatuses"][case["id"]]
            event = _latest_event(case)
            timestamp = (event or {}).get("verifiedAt") or (event or {}).get("recordedAt") or "无"
            latest_result = (event or {}).get("result") or "无"
            event_evidence = (event or {}).get("evidence", [])
            evidence_text = "; ".join(f"{item['path']} (`{item['sha256']}`)" for item in event_evidence) or "无"
            lines.append(
                f"| `{_md_cell(case['id'])}` | {_md_cell(', '.join(case['ruleIds']))} | {_md_cell(case['kind'])} | {STATUS_ZH[status]} | {_md_cell(detail)}；result={latest_result}；{timestamp} | {_md_cell(evidence_text)} |"
            )
    lines.extend(["", "问题："])
    if not derived["issues"]:
        lines.append("- 无已登记问题。")
    else:
        for row in derived["issues"]:
            issue = row["issue"]
            issue_evidence = ", ".join(f"{item['path']} ({item['sha256']})" for item in issue["evidence"])
            lines.append(
                f"- `{issue['id']}` [{issue['severity']}] {issue['title']}；case `{issue['caseId']}`；状态：{row['status']}；证据：{issue_evidence}"
            )
    lines.extend(
        [
            "",
            "## 历史与判定说明",
            "",
            "- tester的record只记观察；人工、真实设备和外部副作用由coordinator用verify独立复验。",
            "- 确定性自动测试可用coordinator的machine-verify登记单次机器结果；它绑定脚本hash、构建epoch和证据hash。",
            "- build会递增epoch；旧记录保留在cases.json与audit.jsonl，但旧epoch的verify不再作为当前通过。",
            "- 任一规则未覆盖全部规则场景、未拆解complete、无局部证据案例、未执行、失败、受阻、待澄清、待复验，或基准/构建hash变化，都会使全量通过为否。",
            "- 规则场景是验收义务，局部证据案例只证明其明确断言；新 run 不再把 E01–E11 作为必过项，历史 E 流程仅通过旧版 run 兼容读取。",
            "- cases.json和issues.json只提供追加历史操作；本地文件本身没有防篡改或身份验证能力。",
            "",
        ]
    )
    report_path = run_dir / "REPORT.md"
    info = _lstat(report_path)
    if info is not None and (stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode)):
        raise LedgerError("REPORT.md必须是普通文件")
    temporary = report_path.with_name(f".REPORT.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text("\n".join(lines), encoding="utf-8")
        os.replace(temporary, report_path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _report(args: argparse.Namespace) -> int:
    run_dir, _marker = _load_run(args.run)
    _write_report(run_dir)
    print((run_dir / "REPORT.md").read_text(encoding="utf-8"), end="")
    return 0


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Rambo本地验收台账；不启动应用、不控制电脑")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init-run", help="从产品决策和验收矩阵建立新run")
    init.add_argument("--project", required=True)
    init.add_argument("--mode", choices=("app", "dev"), default="app", help="app打包运行或dev开发运行")
    init.add_argument("--app", help="app模式的Rambo.app目录")
    init.add_argument("--out", required=True, help="project/acceptance-runs/<runid>")
    init.set_defaults(handler=_init_run)

    plan = sub.add_parser("plan", help="追加子case与coordinator拆解确认")
    plan.add_argument("--run", required=True)
    plan.add_argument("--input", required=True, help="JSON文本或JSON文件路径")
    plan.add_argument("--actor", required=True, choices=("coordinator", "tester", "fixer"))
    plan.set_defaults(handler=_plan)

    for name, handler, actor in (("record", _record, "tester"), ("verify", _verify, "coordinator")):
        command = sub.add_parser(name, help="记录测试观察" if name == "record" else "coordinator复验")
        command.add_argument("--run", required=True)
        command.add_argument("--case", required=True)
        command.add_argument("--result", required=True, choices=STATUS_VALUES if name == "record" else VERIFY_VALUES)
        command.add_argument("--actual", required=True)
        command.add_argument("--evidence", required=True, nargs="+")
        command.add_argument("--actor", required=True, choices=("coordinator", "tester", "fixer"))
        command.set_defaults(handler=handler)

    machine_verify = sub.add_parser("machine-verify", help="登记确定性自动测试的单次机器证据")
    machine_verify.add_argument("--run", required=True)
    machine_verify.add_argument("--case", required=True)
    machine_verify.add_argument("--result", required=True, choices=("pass",))
    machine_verify.add_argument("--actual", required=True)
    machine_verify.add_argument("--evidence", required=True, nargs="+")
    machine_verify.add_argument("--test-id", required=True)
    machine_verify.add_argument("--test-command", required=True)
    machine_verify.add_argument("--suite-hash", required=True)
    machine_verify.add_argument("--actor", required=True, choices=("coordinator", "tester", "fixer"))
    machine_verify.set_defaults(handler=_machine_verify)

    issue = sub.add_parser("issue", help="由tester登记可复现问题")
    issue.add_argument("--run", required=True)
    issue.add_argument("--case", required=True)
    issue.add_argument("--input", required=True, help="含reproduction/expected/actual/severity/evidence的JSON")
    issue.add_argument("--actor", required=True, choices=("coordinator", "tester", "fixer"))
    issue.set_defaults(handler=_issue)

    fix = sub.add_parser("fix", help="由fixer追加修复记录")
    fix.add_argument("--run", required=True)
    fix.add_argument("--issue", required=True)
    fix.add_argument("--input", required=True, help="含modifiedFiles/explanation/newBuildHash的JSON")
    fix.add_argument("--actor", required=True, choices=("coordinator", "tester", "fixer"))
    fix.set_defaults(handler=_fix)

    build = sub.add_parser("build", help="由coordinator登记新App或开发模式构建")
    build.add_argument("--run", required=True)
    build.add_argument("--mode", choices=("app", "dev"), help="默认沿用本run当前模式")
    build.add_argument("--app", help="app模式的Rambo.app目录")
    build.add_argument("--actor", required=True, choices=("coordinator", "tester", "fixer"))
    build.set_defaults(handler=_build)

    check_build = sub.add_parser("check-build", help="只读检查当前App或开发构建指纹")
    check_build.add_argument("--run", required=True)
    check_build.set_defaults(handler=_check_build)

    report = sub.add_parser("report", help="派生并打印中文覆盖报告")
    report.add_argument("--run", required=True)
    report.set_defaults(handler=_report)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = make_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except LedgerError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"文件操作失败：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
