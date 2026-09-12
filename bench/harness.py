# -*- coding: utf-8 -*-
"""roster-bench 跑测骨架：遍历 任务×角色配置，派发经 adapter，收集与判分。

一行 = 一个 task 的结果（brief 契约字段 + judge_status 判分可用性标记）：
    {task_id, difficulty, pass_programmatic, pass_judge, pass_overall,
     latency_s, tokens_in, tokens_out, judge_status, ...}

judge 维度语义（不静默 pass）：
- 题无 semantic 判据 → judge_status="not_needed"，pass_judge=None，overall=programmatic
- judge 可用 → judge_status="ok"，pass_judge=全部语义判词 pass，overall=两者与
- judge 不可用 → judge_status="unavailable"，pass_judge=None，overall=False，
  judge_error 记原因，summary 单独计数 judge_unavailable
"""
from __future__ import annotations

import hashlib
import json
import time

from scorers import score_task, semantic_items


def suite_hash(tasks):
    """任务集指纹：canonical JSON 的 sha256。任务集任何内容变更即失效 baseline。"""
    canonical = json.dumps(tasks, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _judge_dimension(task, final_text, judge):
    """返回 (pass_judge, judge_status, judge_error, verdicts)。"""
    if not semantic_items(task.get("outputs") or []):
        return None, "not_needed", None, []
    outcome = judge.judge_task(task, final_text)
    if not outcome["available"]:
        return None, "unavailable", outcome.get("error") or "judge 不可用", []
    verdicts = outcome["verdicts"]
    passed = all(v["verdict"] == "pass" for v in verdicts)
    return passed, "ok", None, verdicts


def run_suite(tasks, adapter, judge, env, role):
    """跑一轮完整套件，返回 (rows, summary)。"""
    rows = []
    for task in tasks:
        row = {
            "task_id": task["id"],
            "difficulty": task["difficulty"],
            "pass_programmatic": False,
            "pass_judge": None,
            "pass_overall": False,
            "judge_status": "not_needed",
            "latency_s": 0.0,
            "tokens_in": 0,
            "tokens_out": 0,
            "failed_checks": [],
            "judge_error": None,
            "dispatch_error": None,
        }

        started = time.perf_counter()
        try:
            result = adapter.dispatch(task, role, env)
        except Exception as exc:  # 派发失败记为该题失败，不中断整卷
            row["dispatch_error"] = "%s: %s" % (type(exc).__name__, exc)
            row["latency_s"] = round(time.perf_counter() - started, 4)
            rows.append(row)
            continue
        row["latency_s"] = round(time.perf_counter() - started, 4)
        row["tokens_in"] = int(result.tokens_in)
        row["tokens_out"] = int(result.tokens_out)
        final_text = result.final_text or ""

        programmatic = score_task(task, final_text, actual_state=None, env=env)
        row["pass_programmatic"] = programmatic["pass"]
        row["failed_checks"] = [
            {"name": c["name"], "detail": c["detail"]} for c in programmatic["checks"] if not c["ok"]
        ]

        pass_judge, judge_status, judge_error, _verdicts = _judge_dimension(task, final_text, judge)
        row["pass_judge"] = pass_judge
        row["judge_status"] = judge_status
        row["judge_error"] = judge_error
        if judge_status == "unavailable":
            row["pass_overall"] = False
        elif judge_status == "ok":
            row["pass_overall"] = bool(programmatic["pass"] and pass_judge)
        else:  # not_needed
            row["pass_overall"] = bool(programmatic["pass"])
        rows.append(row)

    return rows, summarize(tasks, rows, adapter.name, judge.name)


def summarize(tasks, rows, adapter_name, judge_name):
    """汇总：pass@1（overall）、分 difficulty 通过率、judge 不可用计数、成本合计。"""
    total = len(rows)
    passed_overall = sum(1 for r in rows if r["pass_overall"])
    passed_programmatic = sum(1 for r in rows if r["pass_programmatic"])
    by_difficulty = {}
    for difficulty in ("easy", "medium", "hard"):
        subset = [r for r in rows if r["difficulty"] == difficulty]
        cleared = sum(1 for r in subset if r["pass_overall"])
        by_difficulty[difficulty] = {
            "total": len(subset),
            "passed_overall": cleared,
            "pass_rate": round(cleared / len(subset), 4) if subset else None,
        }
    return {
        "adapter": adapter_name,
        "judge": judge_name,
        "total": total,
        "passed_overall": passed_overall,
        "passed_programmatic": passed_programmatic,
        "pass_at_1": round(passed_overall / total, 4) if total else None,
        "judge_unavailable": sum(1 for r in rows if r["judge_status"] == "unavailable"),
        "by_difficulty": by_difficulty,
        "tokens_in": sum(r["tokens_in"] for r in rows),
        "tokens_out": sum(r["tokens_out"] for r in rows),
        "latency_s_total": round(sum(r["latency_s"] for r in rows), 4),
    }
