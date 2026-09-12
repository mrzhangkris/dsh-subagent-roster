# -*- coding: utf-8 -*-
"""roster-bench 环境：固定文档集的加载、语境装配与重放能力声明。

- env/documents 下的冻结副本是全部题目的答案锚（判分客观性），README.md 只作
  清单不进语境。
- v1 环境仅文档集、无状态库：DocumentEnv 刻意不提供 replay_actions()，scorers
  据此把重放维度自然跳过；后续带状态库的环境实现 replay_actions(actions)->state
  即可接入重放判分（duck-typing，框架预留）。
"""
from __future__ import annotations

from pathlib import Path

MANIFEST_NAME = "README.md"


class DocumentEnv:
    """固定文档集环境。"""

    def __init__(self, documents_dir):
        self.documents_dir = Path(documents_dir)
        self._docs = {}

    def load(self):
        """读取全部冻结文档（README.md 视为清单排除）。目录缺失时大声失败。"""
        if not self.documents_dir.is_dir():
            raise FileNotFoundError("文档目录不存在：%s" % self.documents_dir)
        self._docs = {}
        for path in sorted(self.documents_dir.glob("*.md")):
            if path.name == MANIFEST_NAME:
                continue
            self._docs[path.name] = path.read_text(encoding="utf-8")
        if not self._docs:
            raise FileNotFoundError("文档目录为空：%s" % self.documents_dir)
        return self

    def names(self):
        return sorted(self._docs)

    def document(self, name):
        return self._docs[name]

    def corpus_text(self):
        """全集拼接文本，供资产守卫测试验证字面量锚点存在性。"""
        return "\n\n".join("%s\n%s" % (name, self._docs[name]) for name in sorted(self._docs))

    def compose_prompt(self, role, task):
        """派发 prompt = 角色设定 + 全部冻结文档 + 任务指令。"""
        parts = [str(role.get("system") or "").strip()]
        parts.append("## 可用文档（答案只能出自这些文档）\n")
        for name in sorted(self._docs):
            parts.append("### 文档：%s\n\n%s" % (name, self._docs[name]))
        parts.append(
            "## 任务\n\n%s\n\n请直接作答；引用事实时保留文档原文表述，不要编造文档中不存在的内容。"
            % str(task.get("instruction") or "").strip()
        )
        return "\n\n".join(part for part in parts if part)
