# -*- coding: utf-8 -*-
"""baixiao 任务集资产守卫（TDD）：结构合法 + 全部字面量锚点都能在冻结文档集中找到。

这一组测试保证「基准内容自持」：任务集答案全部可从 bench/env/documents 得出，
判分客观性不依赖仓库实时文件。
"""
import json
import sys
import unittest
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BENCH))

from env import DocumentEnv  # noqa: E402
from scorers import literal_items, semantic_items, validate_tasks  # noqa: E402

SUITE_PATH = BENCH / "tasks" / "baixiao.json"
DOCS_DIR = BENCH / "env" / "documents"


def load_suite():
    with open(SUITE_PATH, encoding="utf-8") as handle:
        return json.load(handle)


class BaixiaoSuiteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.suite = load_suite()
        cls.tasks = cls.suite["tasks"]
        cls.env = DocumentEnv(str(DOCS_DIR))
        cls.env.load()
        cls.corpus = cls.env.corpus_text()

    def test_suite_validates(self):
        self.assertEqual(validate_tasks(self.suite), [])

    def test_exactly_8_tasks_with_difficulty_split_4_2_2(self):
        self.assertEqual(len(self.tasks), 8)
        counts = {"easy": 0, "medium": 0, "hard": 0}
        for task in self.tasks:
            counts[task["difficulty"]] += 1
        self.assertEqual(counts, {"easy": 4, "medium": 2, "hard": 2})

    def test_ids_are_bx_series(self):
        self.assertEqual([t["id"] for t in self.tasks], ["bx-%02d" % i for i in range(1, 9)])

    def test_every_literal_anchor_exists_in_frozen_documents(self):
        missing = []
        for task in self.tasks:
            for literal in literal_items(task["outputs"]):
                if literal.lower() not in self.corpus.lower():
                    missing.append("%s: %r" % (task["id"], literal))
        self.assertEqual(missing, [])

    def test_output_dimension_mix_per_brief(self):
        for task in self.tasks:
            literals = literal_items(task["outputs"])
            semantics = semantic_items(task["outputs"])
            if task["difficulty"] == "easy":
                self.assertFalse(semantics, "%s easy 不应有 semantic" % task["id"])
                self.assertGreaterEqual(len(literals), 2)
            elif task["difficulty"] == "medium":
                self.assertEqual(len(literals), 1, "%s medium 应为 1 字面量" % task["id"])
                self.assertEqual(len(semantics), 1)
            else:  # hard
                self.assertEqual(len(semantics), 1, "%s hard 应为 1 semantic" % task["id"])
                self.assertEqual(len(literals), 1)

    def test_instructions_are_second_person(self):
        for task in self.tasks:
            self.assertTrue(task["instruction"].startswith(("你是", "请", "假设你是")),
                            "%s instruction 应面向角色（第二人称）" % task["id"])

    def test_v1_tasks_have_no_actions(self):
        for task in self.tasks:
            self.assertEqual(task.get("actions", []), [])


if __name__ == "__main__":
    unittest.main()
