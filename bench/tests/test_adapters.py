# -*- coding: utf-8 -*-
"""roster-bench adapters/env 单测（TDD）。

覆盖：StubAdapter 回复查找/回显兜底/回复文件加载、CliAdapter 未接线报错、
StubJudge 镜像语义、KimiJudge 不可用传播、DocumentEnv 装配与无状态库形态。
"""
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from adapters import AdapterResult, CliAdapter, KimiJudge, StubAdapter, StubJudge  # noqa: E402
from env import DocumentEnv  # noqa: E402

ROLE = {"name": "t", "system": "你是测试角色。"}
TASK = {"id": "bx-t", "difficulty": "easy", "instruction": "回答问题。", "actions": [], "outputs": ["A"]}


class StubAdapterTest(unittest.TestCase):
    def test_returns_canned_reply_by_task_id(self):
        adapter = StubAdapter(replies={"bx-t": "预置答复"})
        result = adapter.dispatch(TASK, ROLE)
        self.assertIsInstance(result, AdapterResult)
        self.assertEqual(result.final_text, "预置答复")
        self.assertEqual(result.tokens_in, 0)
        self.assertEqual(result.tokens_out, 0)

    def test_echo_fallback_contains_instruction(self):
        result = StubAdapter(replies={}).dispatch(TASK, ROLE)
        self.assertIn("回答问题", result.final_text)

    def test_replies_path_loading(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "replies.json"
            path.write_text(json.dumps({"bx-t": "文件回复"}, ensure_ascii=False), encoding="utf-8")
            adapter = StubAdapter(replies_path=str(path))
            self.assertEqual(adapter.dispatch(TASK, ROLE).final_text, "文件回复")


class CliAdapterTest(unittest.TestCase):
    def test_not_wired_yet(self):
        with self.assertRaises(NotImplementedError):
            CliAdapter(profile="web").dispatch(TASK, ROLE)


class StubJudgeTest(unittest.TestCase):
    def test_mirror_pass_when_literals_hit(self):
        judge = StubJudge()
        task = {"id": "x", "outputs": ["事实A", {"semantic": "是否说明X"}]}
        outcome = judge.judge_task(task, "答复包含事实A")
        self.assertTrue(outcome["available"])
        self.assertEqual(outcome["verdicts"][0]["verdict"], "pass")

    def test_mirror_fail_when_literals_miss(self):
        judge = StubJudge()
        task = {"id": "x", "outputs": ["事实A", {"semantic": "是否说明X"}]}
        outcome = judge.judge_task(task, "答非所问")
        self.assertEqual(outcome["verdicts"][0]["verdict"], "fail")

    def test_no_semantic_no_verdicts(self):
        outcome = StubJudge().judge_task({"id": "x", "outputs": ["A"]}, "任意")
        self.assertTrue(outcome["available"])
        self.assertEqual(outcome["verdicts"], [])


class KimiJudgeTest(unittest.TestCase):
    def test_missing_key_marks_unavailable(self):
        def must_not_call(*_args):
            raise AssertionError("无 key 时不应发起任何请求")

        with mock.patch.dict(os.environ):
            os.environ.pop("KIMI_CODE_API_KEY", None)
            outcome = KimiJudge(api_key=None, transport=must_not_call).judge_task(
                {"id": "x", "outputs": [{"semantic": "s"}]}, "答复")
        self.assertFalse(outcome["available"])
        self.assertEqual(outcome["verdicts"], [])
        self.assertTrue(outcome["error"])

    def test_pass_path_with_stub_transport(self):
        body = json.dumps({"choices": [{"message": {"content": '{"verdict": "pass", "reason": "ok"}'}}]})
        transport = lambda *args: (200, body)  # noqa: E731
        outcome = KimiJudge(api_key="k", transport=transport).judge_task(
            {"id": "x", "outputs": [{"semantic": "是否说明X"}]}, "答复")
        self.assertTrue(outcome["available"])
        self.assertEqual(outcome["verdicts"][0]["verdict"], "pass")
        self.assertEqual(outcome["verdicts"][0]["criterion"], "是否说明X")

    def test_endpoint_failure_marks_unavailable(self):
        transport = lambda *args: (500, "boom")  # noqa: E731
        outcome = KimiJudge(api_key="k", transport=transport).judge_task(
            {"id": "x", "outputs": [{"semantic": "s"}]}, "答复")
        self.assertFalse(outcome["available"])
        self.assertTrue(outcome["error"])


class DocumentEnvTest(unittest.TestCase):
    def setUp(self):
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        (root / "doc_a.md").write_text("# 文档A\n事实甲", encoding="utf-8")
        (root / "doc_b.md").write_text("# 文档B\n事实乙", encoding="utf-8")
        (root / "README.md").write_text("清单说明，不属于语境", encoding="utf-8")
        self.env = DocumentEnv(str(root))
        self.env.load()

    def tearDown(self):
        self._tmp.cleanup()

    def test_load_reads_documents_but_not_manifest_readme(self):
        names = self.env.names()
        self.assertEqual(names, ["doc_a.md", "doc_b.md"])
        self.assertIn("事实甲", self.env.document("doc_a.md"))

    def test_compose_prompt_contains_docs_and_task(self):
        prompt = self.env.compose_prompt(ROLE, TASK)
        self.assertIn("你是测试角色。", prompt)
        self.assertIn("回答问题", prompt)
        self.assertIn("事实甲", prompt)
        self.assertIn("事实乙", prompt)
        self.assertNotIn("清单说明，不属于语境", prompt)

    def test_document_env_has_no_replay_support(self):
        self.assertFalse(hasattr(self.env, "replay_actions"))

    def test_missing_dir_fails_loudly(self):
        with self.assertRaises(FileNotFoundError):
            DocumentEnv(str(Path(self._tmp.name) / "nope")).load()


if __name__ == "__main__":
    unittest.main()
