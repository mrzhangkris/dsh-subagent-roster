# -*- coding: utf-8 -*-
"""roster-bench 派发通道抽象（adapter）与判官实现。

本任务的全部产出不依赖插件挂载：
- StubAdapter：自测用，回显预置/固定文本，零网络零模型。
- CliAdapter：dsh CLI headless 通道，Task 11 接线后启用；本任务只立协议。
- StubJudge：自测判官，语义 verdict 镜像程序化字面判定（确定性、零网络），
  用于打通 harness 的 judge 维度管线；真语义判分由 KimiJudge 承担。
- KimiJudge：逐条语义判据调用 judge.judge_semantic（kimi-for-coding）；
  不可用时返回 available=False，由 harness 标记 judge-unavailable，绝不静默 pass。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from judge import DEFAULT_BASE_URL, DEFAULT_MODEL, JudgeUnavailableError, judge_semantic
from scorers import check_literals, semantic_items


@dataclass
class AdapterResult:
    """一次派发的统一产物。tokens 计数由真实通道回填；stub 恒为 0。"""

    final_text: str
    tokens_in: int = 0
    tokens_out: int = 0
    meta: dict = field(default_factory=dict)


class StubAdapter:
    """自测通道：按 task id 回预置回复；缺省时回显任务指令。"""

    name = "stub"

    def __init__(self, replies=None, replies_path=None, default_reply=None):
        self.replies = dict(replies or {})
        if replies_path:
            with open(replies_path, encoding="utf-8") as handle:
                self.replies.update(json.load(handle))
        self.default_reply = default_reply

    def dispatch(self, task, role, env=None):
        task_id = task.get("id")
        if task_id in self.replies:
            text = self.replies[task_id]
        elif self.default_reply is not None:
            text = self.default_reply
        else:
            text = "（stub 回显）%s" % task.get("instruction", "")
        return AdapterResult(final_text=text, meta={"adapter": self.name, "task_id": task_id})


class CliAdapter:
    """dsh CLI headless 通道。

    Task 11 接线时在此实现：以 headless 模式调用 dsh CLI（携带 env 装配的
    prompt），解析 stdout 为 final_text，并从 CLI 输出回填 tokens_in/tokens_out。
    在接线完成前，任何 dispatch 都显式失败，避免半可用的假通道混入基准结果。
    """

    name = "cli"

    def __init__(self, profile=None, command_template=None, timeout_s=600.0):
        self.profile = profile
        self.command_template = command_template
        self.timeout_s = timeout_s

    def dispatch(self, task, role, env=None):
        raise NotImplementedError(
            "CliAdapter 未接线：dsh CLI headless 参数与输出解析由 Task 11 提供，"
            "在此之前 cli 通道不得参与基准运行"
        )


class StubJudge:
    """自测判官：语义 verdict 镜像程序化字面判定结果。

    语义：该题全部字面判据命中 → 全部 semantic 判为 pass；任一未命中 → 全部
    fail。它不模拟真实语义理解，只让 harness 的 judge 管线在零网络下可确定性
    跑通（含 pass/fail 两种行形态）。
    """

    name = "stub"

    def judge_task(self, task, final_text):
        literals_ok = all(check["ok"] for check in check_literals(task.get("outputs") or [], final_text))
        verdicts = [
            {
                "criterion": criterion,
                "verdict": "pass" if literals_ok else "fail",
                "reason": "stub 判官：镜像程序化字面判定（%s）" % ("全命中" if literals_ok else "存在未命中"),
            }
            for criterion in semantic_items(task.get("outputs") or [])
        ]
        return {"available": True, "verdicts": verdicts, "error": None}


class KimiJudge:
    """真语义判官：kimi-for-coding（见 judge.py 的约束与重试语义）。"""

    name = "kimi"

    def __init__(self, api_key=None, base_url=DEFAULT_BASE_URL, model=DEFAULT_MODEL,
                 transport=None, timeout_s=None):
        self.api_key = api_key
        self.base_url = base_url
        self.model = model
        self.transport = transport
        self.timeout_s = timeout_s

    def judge_task(self, task, final_text):
        verdicts = []
        for criterion in semantic_items(task.get("outputs") or []):
            kwargs = {"api_key": self.api_key, "base_url": self.base_url, "model": self.model}
            if self.transport is not None:
                kwargs["transport"] = self.transport
            if self.timeout_s is not None:
                kwargs["timeout_s"] = self.timeout_s
            try:
                verdicts.append(judge_semantic(criterion, final_text, **kwargs))
            except JudgeUnavailableError as exc:
                return {"available": False, "verdicts": [], "error": str(exc)}
        return {"available": True, "verdicts": verdicts, "error": None}
