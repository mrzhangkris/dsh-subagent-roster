# -*- coding: utf-8 -*-
"""roster-bench 程序化判分：字面输出匹配 + 重放动作终态 diff。

设计约束（task-10-brief）：
- 确定性、零模型调用：同一输入永远得到同一结果，可单测可复现。
- 字面匹配：大小写不敏感子串；outputs 中字符串项逐个检查，全部命中该维度才 pass。
- 重放（tau-bench 范式）：有 actions 的题在 env 副本重放得期望终态，与 agent 实际
  产出状态 diff。v1 环境仅文档集、无状态库，此维度对现有 8 题自然跳过
  （框架支持、题目暂不用——为后续带环境任务预留）。
- 输出协议：score_task(task, final_text, actual_state=None, env=None)
  -> {"pass": bool, "checks": [{"name", "ok", "detail", "skipped"?}]}
- semantic 判据不属于本模块：由 judge.py 语义判分，两维度严格分离。
"""
from __future__ import annotations

import re

DIFFICULTIES = ("easy", "medium", "hard")
_WS = re.compile(r"\s+")


def normalize_text(text):
    """判分归一化：大小写不敏感 + 连续空白折叠为单空格。"""
    return _WS.sub(" ", str(text or "").casefold()).strip()


def is_literal(item):
    return isinstance(item, str)


def literal_items(outputs):
    """outputs 中的字面量判据（字符串项）。"""
    return [item for item in (outputs or []) if is_literal(item)]


def semantic_items(outputs):
    """outputs 中的语义判据（{"semantic": ...} 项），本模块不判它们。"""
    found = []
    for item in (outputs or []):
        if isinstance(item, dict) and isinstance(item.get("semantic"), str) and item["semantic"].strip():
            found.append(item["semantic"])
    return found


def check_literals(outputs, final_text):
    """字面维度：全部命中才 pass（该维度）。"""
    norm_reply = normalize_text(final_text)
    checks = []
    for i, literal in enumerate(literal_items(outputs)):
        norm_literal = normalize_text(literal)
        ok = bool(norm_literal) and norm_literal in norm_reply
        checks.append({
            "name": "literal:%d" % i,
            "ok": ok,
            "detail": "%r %s" % (literal, "命中" if ok else "未命中"),
        })
    return checks


def check_replay(task, actual_state, env):
    """重放维度：actions 在 env 重放得期望终态，与 actual_state diff。

    - 任务无 actions：自然跳过（skipped=True, ok=True）。
    - 有 actions 但 env 不支持重放：同样跳过——v1 文档环境即此形态，
      框架为后续带状态库的任务预留（skipped=True, ok=True）。
    - 有 actions 且 env 可重放：确定性 diff，actual_state 缺失按失败计。
    """
    actions = task.get("actions") or []
    if not actions:
        return {"name": "replay", "ok": True, "skipped": True, "detail": "任务无 actions，重放维度跳过"}
    if env is None or not hasattr(env, "replay_actions"):
        return {
            "name": "replay",
            "ok": True,
            "skipped": True,
            "detail": "env 无状态库，重放维度跳过（框架预留，v1 文档环境）",
        }
    expected = env.replay_actions(actions)
    if actual_state is None:
        return {
            "name": "replay",
            "ok": False,
            "skipped": False,
            "detail": "env 可重放但未提供 actual_state，无法对比终态",
        }
    ok = expected == actual_state
    detail = "终态一致" if ok else "终态不一致 expected=%r actual=%r" % (expected, actual_state)
    return {"name": "replay", "ok": ok, "skipped": False, "detail": detail}


def score_task(task, final_text, actual_state=None, env=None):
    """程序化判分主入口（协议见模块 docstring）。"""
    checks = check_literals(task.get("outputs") or [], final_text)
    checks.append(check_replay(task, actual_state, env))
    return {"pass": all(c["ok"] for c in checks), "checks": checks}


def validate_tasks(suite):
    """任务集静态校验，返回错误列表（空列表 = 合法）。

    - id 非空且唯一；difficulty ∈ {easy, medium, hard}；instruction 非空
    - outputs 非空；semantic 项必须是非空字符串
    - easy 题 ≥2 处字面量（brief 约定）
    - actions（可选）必须是 [{name, arguments}] 形状
    """
    errors = []
    tasks = suite.get("tasks") if isinstance(suite, dict) else suite
    if not tasks:
        return ["任务集为空"]
    seen_ids = set()
    for idx, task in enumerate(tasks):
        where = "task[%d]" % idx
        tid = task.get("id")
        if not tid or not str(tid).strip():
            errors.append("%s 缺少非空 id" % where)
        elif tid in seen_ids:
            errors.append("%s id 重复：%s" % (where, tid))
        else:
            seen_ids.add(tid)
        if task.get("difficulty") not in DIFFICULTIES:
            errors.append("%s difficulty 非法：%r（应为 easy/medium/hard）" % (where, task.get("difficulty")))
        if not str(task.get("instruction") or "").strip():
            errors.append("%s instruction 为空" % where)
        outputs = task.get("outputs")
        if not isinstance(outputs, list) or not outputs:
            errors.append("%s outputs 必须是非空列表" % where)
            outputs = []
        for item in outputs:
            if isinstance(item, dict) and "semantic" not in item:
                errors.append("%s outputs 中 dict 项缺少 semantic 键：%r" % (where, item))
            elif isinstance(item, dict) and not str(item.get("semantic") or "").strip():
                errors.append("%s semantic 判据为空" % where)
            elif not is_literal(item) and not isinstance(item, dict):
                errors.append("%s outputs 项既非字面量也非 semantic：%r" % (where, item))
        difficulty = task.get("difficulty")
        if difficulty == "easy" and len(literal_items(outputs)) < 2:
            errors.append("%s easy 题至少需要 2 处字面量判据，当前 %d 处" % (where, len(literal_items(outputs))))
        actions = task.get("actions")
        if actions is not None:
            if not isinstance(actions, list):
                errors.append("%s actions 必须是列表" % where)
            else:
                for act in actions:
                    if not isinstance(act, dict) or not act.get("name"):
                        errors.append("%s actions 项必须是含 name 的对象：%r" % (where, act))
                        break
    return errors
