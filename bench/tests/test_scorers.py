# -*- coding: utf-8 -*-
"""roster-bench scorers 单测（TDD：本文件先于 scorers.py 存在并失败）。

运行（零三方依赖，stdlib unittest）：
    /usr/bin/python3 -m unittest discover -t bench -s bench/tests -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scorers import (  # noqa: E402
    check_literals,
    literal_items,
    normalize_text,
    score_task,
    semantic_items,
    validate_tasks,
)


def _task(**over):
    task = {
        "id": "bx-t",
        "difficulty": "easy",
        "instruction": "回答文档问题。",
        "actions": [],
        "outputs": ["0.1.5-rc.1", "pnpm verify"],
    }
    task.update(over)
    return task


class FakeStateEnv:
    """可重放的最小测试环境：set 动作写入键值，累积成终态。"""

    def replay_actions(self, actions):
        state = {}
        for act in actions:
            if act["name"] == "set":
                state[act["arguments"]["key"]] = act["arguments"]["value"]
            else:
                raise ValueError("unknown action: %s" % act["name"])
        return state


class NormalizeTextTest(unittest.TestCase):
    def test_case_insensitive(self):
        self.assertEqual(normalize_text("MaxMembers"), normalize_text("maxmembers"))

    def test_whitespace_collapsed(self):
        self.assertEqual(normalize_text("dsh  plugin\n --profile"), normalize_text("dsh plugin --profile"))


class OutputSplitTest(unittest.TestCase):
    def test_literal_and_semantic_separated(self):
        outputs = ["事实A", {"semantic": "是否说明了X"}]
        self.assertEqual(literal_items(outputs), ["事实A"])
        self.assertEqual(semantic_items(outputs), ["是否说明了X"])


class LiteralMatchTest(unittest.TestCase):
    def test_all_hit_passes(self):
        result = score_task(_task(), "推荐 0.1.5-rc.1，验证用 pnpm verify。")
        self.assertTrue(result["pass"])
        self.assertTrue(all(c["ok"] for c in result["checks"]))

    def test_single_miss_fails(self):
        result = score_task(_task(), "只提到了 0.1.5-rc.1。")
        self.assertFalse(result["pass"])
        missed = [c for c in result["checks"] if not c["ok"]]
        self.assertEqual(len(missed), 1)
        self.assertIn("pnpm verify", missed[0]["detail"])

    def test_case_insensitive_hit(self):
        result = score_task(_task(), "版本 0.1.5-RC.1 与命令 PNPM VERIFY 都重要。")
        self.assertTrue(result["pass"])

    def test_whitespace_variant_hit(self):
        result = score_task(_task(), "命令是 dsh  plugin\n --profile web add；验证跑 0.1.5-rc.1 与 pnpm verify。")
        self.assertTrue(result["pass"])

    def test_semantic_item_does_not_drag_programmatic_score(self):
        task = _task(outputs=["0.1.5-rc.1", {"semantic": "是否解释了重启"}])
        result = score_task(task, "答案是 0.1.5-rc.1。")
        self.assertTrue(result["pass"])

    def test_empty_reply_fails(self):
        result = score_task(_task(), "")
        self.assertFalse(result["pass"])

    def test_check_literals_direct(self):
        checks = check_literals(["Alpha"], "alpha 已发布")
        self.assertEqual(len(checks), 1)
        self.assertTrue(checks[0]["ok"])
        self.assertEqual(checks[0]["name"], "literal:0")


class ReplayTest(unittest.TestCase):
    def test_no_actions_skips_replay(self):
        result = score_task(_task(), "0.1.5-rc.1 pnpm verify")
        replay = [c for c in result["checks"] if c["name"] == "replay"]
        self.assertEqual(len(replay), 1)
        self.assertTrue(replay[0]["skipped"])
        self.assertTrue(replay[0]["ok"])

    def test_actions_without_env_skips(self):
        task = _task(actions=[{"name": "set", "arguments": {"key": "k", "value": "v"}}])
        result = score_task(task, "0.1.5-rc.1 与 pnpm verify")
        replay = [c for c in result["checks"] if c["name"] == "replay"][0]
        self.assertTrue(replay["skipped"])
        self.assertTrue(result["pass"])

    def test_replay_match_passes(self):
        task = _task(actions=[{"name": "set", "arguments": {"key": "k", "value": "v"}}])
        env = FakeStateEnv()
        result = score_task(task, "0.1.5-rc.1 与 pnpm verify", actual_state={"k": "v"}, env=env)
        replay = [c for c in result["checks"] if c["name"] == "replay"][0]
        self.assertFalse(replay["skipped"])
        self.assertTrue(replay["ok"])
        self.assertTrue(result["pass"])

    def test_replay_mismatch_fails(self):
        task = _task(actions=[{"name": "set", "arguments": {"key": "k", "value": "v"}}])
        result = score_task(task, "任意文本", actual_state={"k": "wrong"}, env=FakeStateEnv())
        self.assertFalse(result["pass"])

    def test_replay_without_actual_state_fails(self):
        task = _task(actions=[{"name": "set", "arguments": {"key": "k", "value": "v"}}])
        result = score_task(task, "任意文本", env=FakeStateEnv())
        self.assertFalse(result["pass"])

    def test_literals_ok_but_replay_failed_overall_false(self):
        task = _task(actions=[{"name": "set", "arguments": {"key": "k", "value": "v"}}])
        result = score_task(task, "0.1.5-rc.1 pnpm verify", actual_state={}, env=FakeStateEnv())
        self.assertFalse(result["pass"])


class ValidateTasksTest(unittest.TestCase):
    def test_valid_suite_has_no_errors(self):
        suite = {"suite": "t", "tasks": [_task(), _task(id="bx-2", difficulty="hard", outputs=[{"semantic": "s"}, "x"])]}
        self.assertEqual(validate_tasks(suite), [])

    def test_duplicate_id_detected(self):
        errors = validate_tasks({"tasks": [_task(), _task()]})
        self.assertTrue(any("重复" in e for e in errors))

    def test_easy_needs_two_literals(self):
        errors = validate_tasks({"tasks": [_task(outputs=["only-one"])]})
        self.assertTrue(any("easy" in e for e in errors))

    def test_unknown_difficulty_detected(self):
        errors = validate_tasks({"tasks": [_task(difficulty="extreme")]})
        self.assertTrue(any("difficulty" in e for e in errors))

    def test_empty_outputs_detected(self):
        errors = validate_tasks({"tasks": [_task(outputs=[])]})
        self.assertTrue(any("outputs" in e for e in errors))

    def test_empty_instruction_detected(self):
        errors = validate_tasks({"tasks": [_task(instruction="  ")]})
        self.assertTrue(any("instruction" in e for e in errors))

    def test_empty_task_list_detected(self):
        self.assertTrue(validate_tasks({"tasks": []}))


if __name__ == "__main__":
    unittest.main()
