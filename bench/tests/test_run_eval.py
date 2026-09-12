# -*- coding: utf-8 -*-
"""run_eval 跨通道防护（TDD）：baseline 的 adapter/judge/role 与当前不一致时拒绝对比。

跨通道防护的语义：基准数字只在同通道（adapter/judge/role 完全一致）下可比；
stub 与真判官、不同角色配置的分数混比没有意义。防护同时存在于两处：
- main() 预检（对比模式跑卷之前，真机调用不白跑）；
- compare() 内部（防御性，最终裁决点）。
"""
import io
from contextlib import redirect_stderr
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BENCH))

from harness import suite_hash  # noqa: E402
import run_eval  # noqa: E402

TASKS = [
    {"id": "bx-01", "difficulty": "easy", "instruction": "q", "actions": [], "outputs": ["a", "b"]},
    {"id": "bx-02", "difficulty": "easy", "instruction": "q", "actions": [], "outputs": ["a", "b"]},
]

ROW = {
    "task_id": "bx-01",
    "difficulty": "easy",
    "pass_programmatic": True,
    "pass_judge": None,
    "pass_overall": True,
    "judge_status": "not_needed",
    "latency_s": 0.0,
    "tokens_in": 0,
    "tokens_out": 0,
    "failed_checks": [],
    "judge_error": None,
    "dispatch_error": None,
}

SUMMARY = {
    "adapter": "cli",
    "judge": "kimi",
    "role": "default",
    "total": 1,
    "passed_overall": 1,
    "passed_programmatic": 1,
    "pass_at_1": 1.0,
    "judge_unavailable": 0,
    "by_difficulty": {},
    "tokens_in": 0,
    "tokens_out": 0,
    "latency_s_total": 0.0,
}


def make_baseline(adapter="cli", judge="kimi", role="default"):
    return {
        "schema_version": 1,
        "suite": "baixiao",
        "suite_hash": suite_hash(TASKS),
        "created_at": "2026-09-12T09:00:00+08:00",
        "role": role,
        "adapter": adapter,
        "judge": judge,
        "summary": {"pass_at_1": 0.0},
        "rows": [dict(ROW)],
    }


class ChannelGuardTest(unittest.TestCase):
    def test_same_channel_passes_and_prints_delta(self):
        baseline = make_baseline()
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            run_eval.compare(baseline, "baixiao", TASKS, [dict(ROW)], dict(SUMMARY))
        self.assertIn("delta", buffer.getvalue())

    def test_adapter_mismatch_rejected(self):
        with self.assertRaises(SystemExit) as ctx:
            run_eval.compare(make_baseline(adapter="stub"), "baixiao", TASKS, [dict(ROW)], dict(SUMMARY))
        self.assertEqual(ctx.exception.code, 2)

    def test_judge_mismatch_rejected(self):
        with self.assertRaises(SystemExit) as ctx:
            run_eval.compare(make_baseline(judge="stub"), "baixiao", TASKS, [dict(ROW)], dict(SUMMARY))
        self.assertEqual(ctx.exception.code, 2)

    def test_role_mismatch_rejected(self):
        with self.assertRaises(SystemExit) as ctx:
            run_eval.compare(make_baseline(role="reviewer"), "baixiao", TASKS, [dict(ROW)], dict(SUMMARY))
        self.assertEqual(ctx.exception.code, 2)

    def test_rejection_message_names_all_three_channel_fields(self):
        buffer = io.StringIO()
        try:
            with redirect_stderr(buffer):
                run_eval.compare(make_baseline(adapter="stub"), "baixiao", TASKS, [dict(ROW)], dict(SUMMARY))
        except SystemExit:
            pass
        message = buffer.getvalue()
        for token in ("adapter=stub", "judge=kimi", "role=default", "跨通道防护"):
            self.assertIn(token, message)

    def test_judge_channel_name_maps_api_to_kimi(self):
        self.assertEqual(run_eval.judge_channel_name("api"), "kimi")
        self.assertEqual(run_eval.judge_channel_name("stub"), "stub")


if __name__ == "__main__":
    unittest.main()
