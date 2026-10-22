"""Standard-library tests for the local acceptance ledger CLI."""

import contextlib
import hashlib
import io
import json
import sys
import tempfile
import os
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ledger  # noqa: E402


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.project = self.root / "Rambo"
        (self.project / "docs").mkdir(parents=True)
        (self.project / "docs" / "product-decisions.md").write_text(
            "# Decisions\n\n"
            "| 编号 | 规则 |\n| --- | --- |\n"
            "| P01 | independent app |\n"
            "| B01 | bot object |\n",
            encoding="utf-8",
        )
        (self.project / "docs" / "acceptance-matrix.md").write_text(
            "# Matrix\n\n"
            "| 编号 | 验收对象 | 操作 | 通过条件 | 结果 |\n"
            "| --- | --- | --- | --- | --- |\n"
            "| P01 | independent app | launch | works | 未执行 |\n"
            "| B01 | bot object | create | works | 未执行 |\n\n"
            "## Flows\n\n"
            "| 用例 | 操作 | 规则 | 当前结果 |\n"
            "| --- | --- | --- | --- |\n"
            "| E01 independent flow | full path | P01/B01 | 未执行 |\n",
            encoding="utf-8",
        )
        catalog = {
            "schema": "rambo.test.catalog.v1",
            "journeys": [
                {
                    "id": "J1",
                    "title": "first use",
                    "rules": ["P01"],
                }
            ],
            "releaseSuites": [
                {
                    "id": "bot",
                    "title": "bot suite",
                    "rules": ["B01"],
                }
            ],
            "ruleAcceptance": [
                {
                    "rule": rule_id,
                    "title": title,
                    "scenarios": [
                        {
                            "id": f"{rule_id}-SC-01",
                            "steps": ["prepare fixture", "execute rule path"],
                            "expected": ["observable result matches"],
                            "evidence": ["result artifact"],
                        }
                    ],
                    "evidence": ["result artifact"],
                    "remaining": f"{rule_id} still needs current-build evidence.",
                }
                for rule_id, title in (
                    ("P01", "independent app"),
                    ("B01", "bot object"),
                )
            ],
            "cases": [
                {
                    "id": f"{rule_id}-GAP-01",
                    "rules": [rule_id],
                    "gate": "release",
                    "layer": "document",
                    "target": "docs/acceptance-matrix.md",
                    "testName": None,
                    "status": "not_implemented",
                    "limitations": [f"{rule_id} executable acceptance path is pending."],
                }
                for rule_id in ("P01", "B01")
            ],
        }
        (self.project / "tests" / "acceptance").mkdir(parents=True)
        (self.project / "tests" / "acceptance" / "catalog.json").write_text(
            json.dumps(catalog, ensure_ascii=False),
            encoding="utf-8",
        )
        self.app = self.root / "Rambo.app"
        asar = self.app / "Contents" / "Resources" / "app.asar"
        asar.parent.mkdir(parents=True)
        asar.write_bytes(b"fake app build one")
        self.asar = asar
        self.run = self.project / "acceptance-runs" / "unit-run"
        code, out, err = self.invoke(
            ["init-run", "--project", str(self.project), "--app", str(self.app), "--out", str(self.run)]
        )
        self.assertEqual(code, 0, (out, err))

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, argv):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = ledger.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def write_evidence(self, name="proof.txt", data=b"observed"):
        path = self.run / "evidence" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def plan_all(self):
        content = {
            "cases": [
                {
                    "id": rule_id + "-01",
                    "ruleIds": [rule_id],
                    "coverage": {rule_id: "覆盖验收矩阵中该行的所有已定操作和判定条件。"},
                    "kind": "ui",
                    "preconditions": [],
                    "steps": ["执行受控验收步骤"],
                    "expected": ["观察结果符合矩阵要求"],
                }
                for rule_id in ("P01", "B01")
            ],
            "coverageReview": {
                rule_id: {
                    "complete": True,
                    "reason": "已把矩阵中全部正向、边界和恢复条件拆为子case。",
                    "scenarioIds": [f"{rule_id}-SC-01"],
                }
                for rule_id in ("P01", "B01")
            },
        }
        code, out, err = self.invoke(
            ["plan", "--run", str(self.run), "--input", json.dumps(content), "--actor", "coordinator"]
        )
        self.assertEqual(code, 0, (out, err))

    def observe_and_verify(self, case_id, result="pass", evidence=None):
        evidence = evidence or self.write_evidence(case_id + ".txt")
        args = ["--run", str(self.run), "--case", case_id, "--result", result, "--actual", "实际观察已记录", "--evidence", str(evidence)]
        code, out, err = self.invoke(["record", *args, "--actor", "tester"])
        self.assertEqual(code, 0, (out, err))
        code, out, err = self.invoke(["verify", *args, "--actor", "coordinator"])
        self.assertEqual(code, 0, (out, err))

    def prepare_full_pass(self, p01_evidence=None):
        self.plan_all()
        self.observe_and_verify("P01-01", evidence=p01_evidence or self.write_evidence("P01-01.txt"))
        self.observe_and_verify("B01-01")
        code, report, err = self.invoke(["report", "--run", str(self.run)])
        self.assertEqual(code, 0, err)
        self.assertIn("全量通过：**是**", report)
        return report

    def test_init_uses_rule_scenarios_and_groups_without_fake_cases(self):
        marker = json.loads((self.run / "run.json").read_text(encoding="utf-8"))
        cases = json.loads((self.run / "cases.json").read_text(encoding="utf-8"))
        self.assertEqual(marker["schema"], "rambo.acceptance.run.v1")
        self.assertEqual(
            set(marker["baselineHashes"]),
            {"docs/product-decisions.md", "docs/acceptance-matrix.md", "tests/acceptance/catalog.json"},
        )
        self.assertEqual(cases["schema"], "rambo.acceptance.cases.v2")
        self.assertEqual([rule["id"] for rule in cases["rules"]], ["P01", "B01"])
        self.assertEqual([group["id"] for group in cases["groups"]], ["J1", "bot"])
        self.assertEqual(cases["rules"][0]["acceptance"]["scenarioIds"], ["P01-SC-01"])
        self.assertTrue(all(rule["coverageStatus"] == "pending_decomposition" for rule in cases["rules"]))
        self.assertTrue(all(rule["plannedCaseIds"] == [] for rule in cases["rules"]))
        self.assertEqual(cases["cases"], [])
        for name in ("profile", "fixtures", "evidence"):
            self.assertTrue((self.run / name).is_dir())
        report = (self.run / "REPORT.md").read_text(encoding="utf-8")
        self.assertIn("本报告是软件验收记录", report)
        self.assertIn("局部证据案例：0/0", report)

    def test_init_keeps_every_group_for_a_rule_with_multiple_assignments(self):
        catalog_path = self.project / "tests" / "acceptance" / "catalog.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        catalog["journeys"][0]["rules"].append("B01")
        catalog["journeys"].append(
            {
                "id": "J2",
                "title": "second use",
                "rules": ["B01"],
            }
        )
        catalog_path.write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")
        multi_group_run = self.project / "acceptance-runs" / "multi-group-run"

        code, out, err = self.invoke(
            [
                "init-run",
                "--project",
                str(self.project),
                "--app",
                str(self.app),
                "--out",
                str(multi_group_run),
            ]
        )
        self.assertEqual(code, 0, (out, err))
        cases = json.loads((multi_group_run / "cases.json").read_text(encoding="utf-8"))
        rule = next(item for item in cases["rules"] if item["id"] == "B01")
        self.assertEqual(rule["journeyIds"], ["J1", "J2", "bot"])

    def test_dev_mode_fingerprints_live_inputs_and_tracks_source_changes(self):
        source = self.project / "src" / "main" / "index.ts"
        source.parent.mkdir(parents=True)
        source.write_text("export const value = 'first';\n", encoding="utf-8")
        dev_run = self.project / "acceptance-runs" / "dev-run"

        code, out, err = self.invoke([
            "init-run", "--project", str(self.project), "--mode", "dev", "--out", str(dev_run)
        ])
        self.assertEqual(code, 0, (out, err))
        marker = json.loads((dev_run / "run.json").read_text(encoding="utf-8"))
        self.assertEqual(marker["buildMode"], "dev")
        self.assertEqual(marker["buildRoot"], str(self.project.resolve()))
        self.assertNotIn("appPath", marker)
        first_hash = marker["buildHash"]
        self.assertEqual(first_hash, ledger._dev_source_hash(self.project))

        # Acceptance data and generated build output are not source inputs.
        (dev_run / "profile" / "state.sqlite").write_bytes(b"profile data")
        (self.project / "out").mkdir()
        (self.project / "out" / "generated.js").write_text("generated", encoding="utf-8")
        self.assertEqual(first_hash, ledger._dev_source_hash(self.project))

        check_args = ["check-build", "--run", str(dev_run)]
        code, out, err = self.invoke(check_args)
        self.assertEqual(code, 0, (out, err))
        self.assertEqual(json.loads(out)["buildHash"], first_hash)

        source.write_text("export const value = 'changed';\n", encoding="utf-8")
        self.assertNotEqual(first_hash, ledger._dev_source_hash(self.project))
        code, _, err = self.invoke(check_args)
        self.assertEqual(code, 2)
        self.assertIn("尚未登记", err)

        code, out, err = self.invoke([
            "build", "--run", str(dev_run), "--mode", "dev", "--actor", "coordinator"
        ])
        self.assertEqual(code, 0, (out, err))
        marker = json.loads((dev_run / "run.json").read_text(encoding="utf-8"))
        self.assertEqual(marker["buildEpoch"], 1)
        self.assertNotEqual(first_hash, marker["buildHash"])
        self.assertEqual(marker["buildHistory"][-1]["mode"], "dev")
        self.assertEqual(ledger._current_build_hash(marker), marker["buildHash"])
        self.assertIn("开发模式源码与运行时指纹", out)

    def test_dev_mode_rejects_symlinked_source_inputs(self):
        outside = self.root / "outside-assets"
        outside.mkdir()
        (outside / "external.txt").write_text("outside", encoding="utf-8")
        os.symlink(outside, self.project / "assets")
        dev_run = self.project / "acceptance-runs" / "linked-dev-run"
        code, _, err = self.invoke([
            "init-run", "--project", str(self.project), "--mode", "dev", "--out", str(dev_run)
        ])
        self.assertEqual(code, 2)
        self.assertIn("不能是符号链接", err)
        self.assertFalse(dev_run.exists())

    def test_init_rejects_traversal_existing_directory_and_symlink(self):
        code, _, err = self.invoke(
            ["init-run", "--project", str(self.project), "--app", str(self.app), "--out", str(self.project / "elsewhere" / "bad")]
        )
        self.assertEqual(code, 2)
        self.assertIn("acceptance-runs", err)

        code, _, err = self.invoke(
            ["init-run", "--project", str(self.project), "--app", str(self.app), "--out", str(self.run)]
        )
        self.assertEqual(code, 2)
        self.assertIn("已存在", err)

        outside = self.root / "outside"
        outside.mkdir()
        linked_run = self.project / "acceptance-runs" / "linked-run"
        linked_run.symlink_to(outside, target_is_directory=True)
        code, _, err = self.invoke(
            ["init-run", "--project", str(self.project), "--app", str(self.app), "--out", str(linked_run)]
        )
        self.assertEqual(code, 2)
        self.assertIn("符号链接", err)

        linked_project = self.root / "LinkedProject"
        linked_project.mkdir()
        (linked_project / "docs").mkdir()
        (linked_project / "docs" / "product-decisions.md").write_text("", encoding="utf-8")
        (linked_project / "docs" / "acceptance-matrix.md").write_text("", encoding="utf-8")
        (linked_project / "acceptance-runs").symlink_to(outside, target_is_directory=True)
        code, _, err = self.invoke(
            [
                "init-run",
                "--project",
                str(linked_project),
                "--app",
                str(self.app),
                "--out",
                str(linked_project / "acceptance-runs" / "linked-run"),
            ]
        )
        self.assertEqual(code, 2)
        self.assertIn("符号链接", err)

    def test_plan_requires_per_rule_coverage_and_complete_rows_need_cases(self):
        no_case = {"cases": [], "coverageReview": {"P01": {"complete": True, "reason": "all scenarios"}}}
        code, _, err = self.invoke(
            ["plan", "--run", str(self.run), "--input", json.dumps(no_case), "--actor", "coordinator"]
        )
        self.assertEqual(code, 2)
        self.assertIn("尚无对应子case", err)

        missing_coverage = {
            "cases": [
                {
                    "id": "P01-01",
                    "ruleIds": ["P01"],
                    "coverage": {},
                    "kind": "ui",
                    "preconditions": [],
                    "steps": ["step"],
                    "expected": ["expected"],
                }
            ]
        }
        code, _, err = self.invoke(
            ["plan", "--run", str(self.run), "--input", json.dumps(missing_coverage), "--actor", "coordinator"]
        )
        self.assertEqual(code, 2)
        self.assertIn("coverage必须", err)
        self.assertEqual(json.loads((self.run / "cases.json").read_text(encoding="utf-8"))["cases"], [])

    def test_complete_rule_requires_every_acceptance_scenario_and_catalog_evidence(self):
        catalog_path = self.project / "tests" / "acceptance" / "catalog.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        p01 = next(item for item in catalog["ruleAcceptance"] if item["rule"] == "P01")
        p01["scenarios"].append(
            {
                "id": "P01-SC-02",
                "steps": ["restart application", "read persisted profile"],
                "expected": ["same local profile is retained"],
                "evidence": ["restart log"],
            }
        )
        p01_evidence = next(item for item in catalog["cases"] if item["rules"] == ["P01"])
        p01_evidence["status"] = "implemented"
        p01_evidence["testName"] = "implemented P01 evidence"
        p01_evidence["id"] = "RUN-P01-01"
        catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        rerun = self.project / "acceptance-runs" / "rerun"
        code, out, err = self.invoke(
            ["init-run", "--project", str(self.project), "--app", str(self.app), "--out", str(rerun)]
        )
        self.assertEqual(code, 0, (out, err))

        content = {
            "cases": [
                {
                    "id": "RUN-P01-01",
                    "ruleIds": ["P01"],
                    "coverage": {"P01": "covers one scenario"},
                    "kind": "ui",
                    "preconditions": [],
                    "steps": ["execute"],
                    "expected": ["observable"],
                }
            ],
            "coverageReview": {
                "P01": {
                    "complete": True,
                    "reason": "only one scenario checked",
                    "scenarioIds": ["P01-SC-01"],
                }
            },
        }
        code, _, err = self.invoke(
            ["plan", "--run", str(rerun), "--input", json.dumps(content), "--actor", "coordinator"]
        )
        self.assertEqual(code, 2)
        self.assertIn("必须覆盖全部验收场景", err)

        content["coverageReview"]["P01"]["scenarioIds"] = ["P01-SC-01", "P01-SC-02"]
        code, _, err = self.invoke(
            ["plan", "--run", str(rerun), "--input", json.dumps(content), "--actor", "coordinator"]
        )
        self.assertEqual(code, 0, err)

        cases_obj = json.loads((rerun / "cases.json").read_text(encoding="utf-8"))
        p01_run_rule = next(rule for rule in cases_obj["rules"] if rule["id"] == "P01")
        self.assertEqual(p01_run_rule["coverageStatus"], "complete")
        self.assertEqual(p01_run_rule["decompositionReviews"][-1]["scenarioIds"], ["P01-SC-01", "P01-SC-02"])
        code, report, err = self.invoke(["report", "--run", str(rerun)])
        self.assertEqual(code, 0, err)
        self.assertIn("至少一个子case未执行或等待coordinator复验", report)
        self.assertIn("全量通过：**否**", report)

        current = json.loads(catalog_path.read_text(encoding="utf-8"))
        current["ruleAcceptance"][0]["remaining"] = "current catalog revision"
        catalog_path.write_text(json.dumps(current), encoding="utf-8")
        code, report, err = self.invoke(
            ["report", "--run", str(rerun)]
        )
        self.assertEqual(code, 0)
        self.assertIn("全量通过：**否**", report)

    def test_evidence_must_be_real_and_inside_run(self):
        self.plan_all()
        outside = self.root / "outside-proof.txt"
        outside.write_text("outside", encoding="utf-8")
        code, _, err = self.invoke(
            [
                "record",
                "--run",
                str(self.run),
                "--case",
                "P01-01",
                "--result",
                "pass",
                "--actual",
                "observed",
                "--evidence",
                str(outside),
                "--actor",
                "tester",
            ]
        )
        self.assertEqual(code, 2)
        self.assertIn("必须位于运行目录", err)

        link = self.run / "evidence" / "link.txt"
        link.symlink_to(outside)
        code, _, err = self.invoke(
            [
                "record",
                "--run",
                str(self.run),
                "--case",
                "P01-01",
                "--result",
                "pass",
                "--actual",
                "observed",
                "--evidence",
                str(link),
                "--actor",
                "tester",
            ]
        )
        self.assertEqual(code, 2)
        self.assertIn("符号链接", err)

    def test_report_blocks_when_pass_evidence_hash_changes(self):
        evidence = self.write_evidence("P01-01.txt", b"original evidence")
        self.prepare_full_pass(evidence)
        cases_before = json.loads((self.run / "cases.json").read_text(encoding="utf-8"))
        recorded_hash = cases_before["cases"][0]["events"][-1]["evidence"][0]["sha256"]

        evidence.write_bytes(b"rewritten evidence")
        code, report, err = self.invoke(["report", "--run", str(self.run)])
        self.assertEqual(code, 0, err)
        self.assertIn("全量通过：**否**", report)
        self.assertIn("证据无效", report)
        self.assertIn("evidence/P01-01.txt", report)
        self.assertIn("SHA-256不匹配", report)
        cases_after = json.loads((self.run / "cases.json").read_text(encoding="utf-8"))
        self.assertEqual(cases_after["cases"][0]["events"][-1]["evidence"][0]["sha256"], recorded_hash)

    def test_report_blocks_when_pass_evidence_is_deleted(self):
        evidence = self.write_evidence("P01-01.txt", b"original evidence")
        self.prepare_full_pass(evidence)
        evidence.unlink()
        code, report, err = self.invoke(["report", "--run", str(self.run)])
        self.assertEqual(code, 0, err)
        self.assertIn("全量通过：**否**", report)
        self.assertIn("证据无效", report)
        self.assertIn("evidence/P01-01.txt", report)
        self.assertIn("不存在", report)

    def test_report_blocks_evidence_replaced_by_symlink(self):
        evidence = self.write_evidence("P01-01.txt", b"original evidence")
        self.prepare_full_pass(evidence)
        outside = self.root / "outside-proof.txt"
        outside.write_bytes(b"outside")
        evidence.unlink()
        evidence.symlink_to(outside)
        code, report, err = self.invoke(["report", "--run", str(self.run)])
        self.assertEqual(code, 0, err)
        self.assertIn("全量通过：**否**", report)
        self.assertIn("证据无效", report)
        self.assertIn("evidence/P01-01.txt", report)
        self.assertIn("符号链接", report)

    def test_tester_record_pass_is_not_acceptance_and_roles_are_guarded(self):
        self.plan_all()
        evidence = self.write_evidence()
        args = [
            "--run", str(self.run), "--case", "P01-01", "--result", "pass",
            "--actual", "tester's observed pass", "--evidence", str(evidence),
        ]
        code, _, err = self.invoke(["record", *args, "--actor", "tester"])
        self.assertEqual(code, 0, err)
        code, report, err = self.invoke(["report", "--run", str(self.run)])
        self.assertEqual(code, 0, err)
        self.assertIn("全量通过：**否**", report)
        self.assertIn("等待coordinator复验", report)

        code, _, err = self.invoke(["verify", *args, "--actor", "tester"])
        self.assertEqual(code, 2)
        self.assertIn("要求 --actor coordinator", err)
        code, _, err = self.invoke(["verify", *args, "--actor", "fixer"])
        self.assertEqual(code, 2)
        self.assertIn("要求 --actor coordinator", err)

        code, _, err = self.invoke(["verify", *args, "--actor", "coordinator"])
        self.assertEqual(code, 0, err)
        cases = json.loads((self.run / "cases.json").read_text(encoding="utf-8"))
        event = cases["cases"][0]["events"][-1]
        self.assertEqual(event["result"], "pass")
        self.assertEqual(event["actor"], "coordinator")
        self.assertEqual(event["evidence"][0]["sha256"], hashlib.sha256(evidence.read_bytes()).hexdigest())

    def test_verify_uses_latest_current_epoch_observation_and_keeps_old_history(self):
        self.plan_all()
        old_evidence = self.write_evidence("old-observation.txt", b"old observation")
        old_args = [
            "--run", str(self.run), "--case", "P01-01", "--result", "pass",
            "--actual", "首次观察", "--evidence", str(old_evidence),
        ]
        code, out, err = self.invoke(["record", *old_args, "--actor", "tester"])
        self.assertEqual(code, 0, (out, err))
        cases = json.loads((self.run / "cases.json").read_text(encoding="utf-8"))
        old_observation = cases["cases"][0]["events"][-1]
        old_evidence.write_bytes(b"corrected after the first observation")

        latest_evidence = self.write_evidence("latest-observation.txt", b"replacement observation")
        latest_args = [
            "--run", str(self.run), "--case", "P01-01", "--result", "pass",
            "--actual", "更正后的新观察", "--evidence", str(latest_evidence),
        ]
        code, out, err = self.invoke(["record", *latest_args, "--actor", "tester"])
        self.assertEqual(code, 0, (out, err))
        cases = json.loads((self.run / "cases.json").read_text(encoding="utf-8"))
        latest_observation = cases["cases"][0]["events"][-1]

        verification_evidence = self.write_evidence("verification.txt", b"coordinator verification")
        verify_args = [
            "--run", str(self.run), "--case", "P01-01", "--result", "pass",
            "--actual", "按最新观察复验", "--evidence", str(verification_evidence),
        ]
        code, out, err = self.invoke(["verify", *verify_args, "--actor", "coordinator"])
        self.assertEqual(code, 0, (out, err))

        cases = json.loads((self.run / "cases.json").read_text(encoding="utf-8"))
        case = cases["cases"][0]
        observations = [event for event in case["events"] if event.get("type") == "observation"]
        verification = case["events"][-1]
        self.assertEqual([event["eventId"] for event in observations], [old_observation["eventId"], latest_observation["eventId"]])
        self.assertEqual(verification["observationEventIds"], [latest_observation["eventId"]])

        audit = [json.loads(line) for line in (self.run / "audit.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(sum(event["action"] == "record" for event in audit), 2)
        self.assertEqual(sum(event["action"] == "verify" for event in audit), 1)
        marker = json.loads((self.run / "run.json").read_text(encoding="utf-8"))
        status, detail = ledger._case_status(case, marker, ledger._runtime_health(self.run, marker), self.run)
        self.assertEqual((status, detail), ("pass", "coordinator复验"))

        code, report, err = self.invoke(["report", "--run", str(self.run)])
        self.assertEqual(code, 0, err)
        self.assertNotIn("证据无效", report)
        self.assertNotIn("old-observation.txt", report)

    def test_build_epoch_invalidates_old_pass_without_deleting_history(self):
        self.plan_all()
        evidence = self.write_evidence()
        self.observe_and_verify("P01-01", evidence=evidence)
        cases_before = json.loads((self.run / "cases.json").read_text(encoding="utf-8"))
        old_verify = cases_before["cases"][0]["events"][-1]
        self.assertEqual(old_verify["result"], "pass")

        self.asar.write_bytes(b"fake app build two")
        code, _, err = self.invoke(["build", "--run", str(self.run), "--app", str(self.app), "--actor", "coordinator"])
        self.assertEqual(code, 0, err)
        code, report, err = self.invoke(["report", "--run", str(self.run)])
        self.assertEqual(code, 0, err)
        self.assertIn("全量通过：**否**", report)
        self.assertIn("旧记录保留", report)
        cases_after = json.loads((self.run / "cases.json").read_text(encoding="utf-8"))
        self.assertIn(old_verify, cases_after["cases"][0]["events"])
        status, detail = ledger._case_status(
            cases_after["cases"][0],
            json.loads((self.run / "run.json").read_text(encoding="utf-8")),
            ledger._runtime_health(self.run, json.loads((self.run / "run.json").read_text(encoding="utf-8"))),
            self.run,
        )
        self.assertEqual(status, "not_run")
        self.assertIn("旧构建", detail)

    def test_failed_negative_result_never_counts_as_complete(self):
        self.plan_all()
        self.observe_and_verify("P01-01", result="fail")
        code, report, err = self.invoke(["report", "--run", str(self.run)])
        self.assertEqual(code, 0, err)
        self.assertIn("全量通过：**否**", report)
        self.assertIn("| P01 | independent app | J1 | 1/1 | complete |", report)
        self.assertIn("| 失败 | 至少一个子case失败或存在未闭环问题 |", report)

    def test_issue_fix_and_reverification_lifecycle(self):
        self.plan_all()
        evidence = self.write_evidence("issue-proof.txt")
        args = [
            "--run", str(self.run), "--case", "P01-01", "--result", "fail",
            "--actual", "按钮没有响应", "--evidence", str(evidence),
        ]
        code, _, err = self.invoke(["record", *args, "--actor", "tester"])
        self.assertEqual(code, 0, err)
        issue_input = {
            "title": "启动按钮无响应",
            "severity": "high",
            "reproduction": ["打开应用", "点击启动按钮"],
            "expected": "进入主界面",
            "actual": "按钮没有响应",
            "evidence": ["evidence/issue-proof.txt"],
        }
        code, _, err = self.invoke(
            ["issue", "--run", str(self.run), "--case", "P01-01", "--input", json.dumps(issue_input), "--actor", "tester"]
        )
        self.assertEqual(code, 0, err)
        issues = json.loads((self.run / "issues.json").read_text(encoding="utf-8"))["issues"]
        self.assertEqual(issues[0]["id"], "ISSUE-0001")
        self.assertEqual(issues[0]["evidence"][0]["sha256"], hashlib.sha256(evidence.read_bytes()).hexdigest())

        self.asar.write_bytes(b"fixed app build")
        expected_hash = hashlib.sha256(self.asar.read_bytes()).hexdigest()
        fix_input = {
            "modifiedFiles": ["src/main/window.ts"],
            "explanation": "修复启动按钮事件绑定",
            "newBuildHash": expected_hash,
        }
        code, _, err = self.invoke(
            ["fix", "--run", str(self.run), "--issue", "ISSUE-0001", "--input", json.dumps(fix_input), "--actor", "fixer"]
        )
        self.assertEqual(code, 0, err)

        code, _, err = self.invoke(
            ["verify", *args, "--actor", "fixer"]
        )
        self.assertEqual(code, 2)
        self.assertIn("要求 --actor coordinator", err)

        code, _, err = self.invoke(["build", "--run", str(self.run), "--app", str(self.app), "--actor", "coordinator"])
        self.assertEqual(code, 0, err)
        self.observe_and_verify("P01-01", result="pass", evidence=self.write_evidence("retest-proof.txt"))
        issues_obj = json.loads((self.run / "issues.json").read_text(encoding="utf-8"))
        case = json.loads((self.run / "cases.json").read_text(encoding="utf-8"))["cases"][0]
        marker = json.loads((self.run / "run.json").read_text(encoding="utf-8"))
        self.assertEqual(ledger._issue_status(issues_obj["issues"][0], case, marker, self.run), "复验通过")

        (self.run / "evidence" / "retest-proof.txt").unlink()
        code, report, err = self.invoke(["report", "--run", str(self.run)])
        self.assertEqual(code, 0, err)
        self.assertIn("全量通过：**否**", report)
        self.assertIn("关联case证据无效", report)
        self.assertNotEqual(ledger._issue_status(issues_obj["issues"][0], case, marker, self.run), "复验通过")
        (self.run / "evidence" / "issue-proof.txt").unlink()
        code, report, err = self.invoke(["report", "--run", str(self.run)])
        self.assertEqual(code, 0, err)
        self.assertIn("全量通过：**否**", report)
        self.assertIn("evidence/issue-proof.txt", report)
        self.assertIn("证据无效", report)

    def test_full_scope_only_passes_after_all_rows_cases_and_reviews_pass(self):
        self.plan_all()
        for case_id in ("P01-01", "B01-01"):
            self.observe_and_verify(case_id)
        code, report, err = self.invoke(["report", "--run", str(self.run)])
        self.assertEqual(code, 0, err)
        self.assertIn("全量通过：**是**", report)

    def test_machine_verification_is_single_run_pass_but_still_bound_to_artifact_identity(self):
        self.plan_all()
        evidence = self.write_evidence("machine-result.txt", b"deterministic test passed")
        suite_hash = "a" * 64
        args = [
            "--run", str(self.run),
            "--case", "P01-01",
            "--result", "pass",
            "--actual", "确定性测试通过",
            "--evidence", str(evidence),
            "--test-id", "P01-INT-01",
            "--test-command", "npm run verify:feature -- --rules P01",
            "--suite-hash", suite_hash,
            "--actor", "coordinator",
        ]
        code, out, err = self.invoke(["machine-verify", *args])
        self.assertEqual(code, 0, (out, err))

        case = json.loads((self.run / "cases.json").read_text(encoding="utf-8"))["cases"][0]
        event = case["events"][-1]
        self.assertEqual(event["type"], "machine_verification")
        self.assertEqual(event["testId"], "P01-INT-01")
        self.assertEqual(event["suiteHash"], suite_hash)
        marker = json.loads((self.run / "run.json").read_text(encoding="utf-8"))
        self.assertEqual(
            ledger._case_status(case, marker, ledger._runtime_health(self.run, marker), self.run),
            ("pass", "确定性机器证据"),
        )

        code, _, err = self.invoke([
            "machine-verify", *args[:-2], "--actor", "tester"
        ])
        self.assertEqual(code, 2)
        self.assertIn("要求 --actor coordinator", err)

        evidence.write_bytes(b"rewritten machine result")
        code, report, err = self.invoke(["report", "--run", str(self.run)])
        self.assertEqual(code, 0, err)
        self.assertIn("全量通过：**否**", report)
        self.assertIn("证据无效", report)


if __name__ == "__main__":
    unittest.main(verbosity=2)
