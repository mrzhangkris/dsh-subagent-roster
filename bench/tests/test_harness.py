# -*- coding: utf-8 -*-
"""roster-bench harness 单测（TDD）：行结构、汇总数学、judge 不可用语义、suite hash。"""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from adapters import StubAdapter, StubJudge  # noqa: E402
from harness import run_suite, suite_hash  # noqa: E402

EASY = {
    "id": "bx-e1", "difficulty": "easy", "instruction": "问版本。",
    "actions": [], "outputs": ["0.1.5-rc.1", "pnpm verify"],
}
MEDIUM = {
    "id": "bx-m1", "difficulty": "medium", "instruction": "说验证。",
    "actions": [], "outputs": ["pnpm verify", {"semantic": "是否说明了重启"}],
}
ROLE = {"name": "t", "system": "sys"}


class UnavailableJudge:
    name = "fake-unavailable"

    def judge_task(self, task, final_text):
        return {"available": False, "verdicts": [], "error": "端点不可达"}


class RaisingAdapter:
    name = "raising"

    def dispatch(self, task, role, env=None):
        raise RuntimeError("派发失败")


class RunSuiteTest(unittest.TestCase):
    def setUp(self):
        self.env = None

    def test_all_pass_rows_and_summary(self):
        rows, summary = run_suite(
            [EASY, MEDIUM],
            StubAdapter(replies={"bx-e1": "0.1.5-rc.1 与 pnpm verify",
                                 "bx-m1": "先 pnpm verify；安装后要重启 harness 进程"}),
            StubJudge(), self.env, ROLE)
        self.assertEqual(len(rows), 2)
        row_easy = rows[0]
        self.assertTrue(row_easy["pass_programmatic"])
        self.assertIsNone(row_easy["pass_judge"])
        self.assertEqual(row_easy["judge_status"], "not_needed")
        self.assertTrue(row_easy["pass_overall"])
        row_medium = rows[1]
        self.assertEqual(row_medium["judge_status"], "ok")
        self.assertTrue(row_medium["pass_judge"])
        self.assertTrue(row_medium["pass_overall"])
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["passed_overall"], 2)
        self.assertEqual(summary["pass_at_1"], 1.0)
        self.assertEqual(summary["judge_unavailable"], 0)
        self.assertEqual(summary["by_difficulty"]["easy"]["pass_rate"], 1.0)
        self.assertEqual(summary["by_difficulty"]["medium"]["pass_rate"], 1.0)

    def test_literal_failure_marks_row_and_summary(self):
        rows, summary = run_suite(
            [EASY], StubAdapter(replies={"bx-e1": "只答一半 pnpm verify"}), StubJudge(), self.env, ROLE)
        row = rows[0]
        self.assertFalse(row["pass_programmatic"])
        self.assertFalse(row["pass_overall"])
        self.assertTrue(row["failed_checks"])
        self.assertEqual(summary["passed_overall"], 0)
        self.assertEqual(summary["pass_at_1"], 0.0)

    def test_judge_unavailable_not_silent_pass(self):
        rows, summary = run_suite([MEDIUM], StubAdapter(replies={"bx-m1": "pnpm verify 重启"}), UnavailableJudge(),
                                   self.env, ROLE)
        row = rows[0]
        self.assertIsNone(row["pass_judge"])
        self.assertEqual(row["judge_status"], "unavailable")
        self.assertFalse(row["pass_overall"])  # 不可用≠通过
        self.assertTrue(row["judge_error"])
        self.assertEqual(summary["judge_unavailable"], 1)
        self.assertEqual(summary["passed_overall"], 0)

    def test_adapter_error_recorded_not_raised(self):
        rows, summary = run_suite([EASY], RaisingAdapter(), StubJudge(), self.env, ROLE)
        row = rows[0]
        self.assertFalse(row["pass_overall"])
        self.assertTrue(row["dispatch_error"])

    def test_row_schema_has_brief_fields(self):
        rows, _ = run_suite([EASY], StubAdapter(replies={"bx-e1": "0.1.5-rc.1 pnpm verify"}), StubJudge(),
                            self.env, ROLE)
        for key in ("task_id", "difficulty", "pass_programmatic", "pass_judge",
                    "pass_overall", "latency_s", "tokens_in", "tokens_out"):
            self.assertIn(key, rows[0])


class SuiteHashTest(unittest.TestCase):
    def test_stable_for_same_content(self):
        self.assertEqual(suite_hash([EASY]), suite_hash([copy.deepcopy(EASY)]))

    def test_changes_when_task_set_changes(self):
        changed = copy.deepcopy(EASY)
        changed["outputs"] = ["别的判据"]
        self.assertNotEqual(suite_hash([EASY]), suite_hash([changed]))

    def test_changes_on_output_order(self):
        swapped = copy.deepcopy(EASY)
        swapped["outputs"] = list(reversed(swapped["outputs"]))
        self.assertNotEqual(suite_hash([EASY]), suite_hash([swapped]))


if __name__ == "__main__":
    unittest.main()
