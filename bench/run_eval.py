#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""roster-bench CLI 入口。

用法（在仓库根目录，Python 一律 /usr/bin/python3，零三方依赖）：

    # stub 全流程自测（本任务）
    /usr/bin/python3 bench/run_eval.py --suite baixiao --role default --adapter stub --judge stub

    # 真语义判分（KIMI_CODE_API_KEY，kimi-for-coding；本任务不真调）
    /usr/bin/python3 bench/run_eval.py --suite baixiao --role default --adapter cli --judge api

    # 首跑冻结 baseline（Task 11）
    /usr/bin/python3 bench/run_eval.py ... --baseline bench/baseline.json --freeze

    # 对比模式：输出 delta 报告
    /usr/bin/python3 bench/run_eval.py ... --baseline bench/baseline.json

退出码：0 = 评测完成（题目 pass/fail 不影响）；2 = 操作错误（套件非法、
baseline 缺失/任务集变更失效）；3 = cli 通道未接线（Task 11）。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

BENCH_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH_ROOT))

from adapters import CliAdapter, KimiJudge, StubAdapter, StubJudge  # noqa: E402
from env import DocumentEnv  # noqa: E402
from harness import run_suite, suite_hash  # noqa: E402
from scorers import validate_tasks  # noqa: E402

BASELINE_SCHEMA_VERSION = 1
CN_TZ = timezone(timedelta(hours=8))  # 统一北京时间


def now_cn():
    return datetime.now(CN_TZ).isoformat(timespec="seconds")


def fail(message, code=2):
    print("[roster-bench] %s" % message, file=sys.stderr)
    raise SystemExit(code)


def load_suite(suite_name):
    path = BENCH_ROOT / "tasks" / ("%s.json" % suite_name)
    if not path.is_file():
        fail("任务集不存在：%s" % path)
    with open(path, encoding="utf-8") as handle:
        suite = json.load(handle)
    errors = validate_tasks(suite)
    if errors:
        fail("任务集校验失败：\n  - " + "\n  - ".join(errors))
    return suite, path


def load_role(role_ref):
    path = Path(role_ref)
    if not path.is_absolute():
        candidate = BENCH_ROOT / "roles" / ("%s.json" % role_ref)
        path = candidate if candidate.is_file() else BENCH_ROOT / role_ref
    if not path.is_file():
        fail("角色配置不存在：%s" % role_ref)
    with open(path, encoding="utf-8") as handle:
        return json.load(handle), path.name


def build_adapter(name, args):
    if name == "stub":
        replies_path = args.replies or str(BENCH_ROOT / "stub_replies.json")
        return StubAdapter(replies_path=replies_path)
    if name == "cli":
        return CliAdapter(profile=args.profile)
    fail("未知 adapter：%s" % name)


def build_judge(name):
    if name == "stub":
        return StubJudge()
    if name == "api":
        return KimiJudge()
    fail("未知 judge：%s" % name)


def row_line(row):
    def mark(value):
        if value is None:
            return "—"
        return "✓" if value else "✗"

    judge_cell = {"ok": mark(row["pass_judge"]), "not_needed": "n/a", "unavailable": "UNAVAIL"}[row["judge_status"]]
    return "[%s] %-6s %-6s prog=%s judge=%s overall=%s  %.2fs  in=%s out=%s" % (
        "PASS" if row["pass_overall"] else "FAIL",
        row["task_id"],
        row["difficulty"],
        mark(row["pass_programmatic"]),
        judge_cell,
        mark(row["pass_overall"]),
        row["latency_s"],
        row["tokens_in"],
        row["tokens_out"],
    )


def print_report(rows, summary, suite_name, role_name, extra_notes=()):
    print("== roster-bench == suite=%s role=%s adapter=%s judge=%s" % (
        suite_name, role_name, summary["adapter"], summary["judge"]))
    for note in extra_notes:
        print("   注：%s" % note)
    for row in rows:
        print("  " + row_line(row))
        for check in row["failed_checks"]:
            print("        · %s：%s" % (check["name"], check["detail"]))
        if row["judge_error"]:
            print("        · judge_error：%s" % row["judge_error"])
        if row["dispatch_error"]:
            print("        · dispatch_error：%s" % row["dispatch_error"])
    print("-- 汇总 --")
    print("  pass@1(overall)=%s (%d/%d)  programmatic=%d/%d  judge_unavailable=%d" % (
        summary["pass_at_1"], summary["passed_overall"], summary["total"],
        summary["passed_programmatic"], summary["total"], summary["judge_unavailable"]))
    for difficulty, stat in summary["by_difficulty"].items():
        if stat["total"]:
            print("  %-6s %d/%d (%.1f%%)" % (difficulty, stat["passed_overall"], stat["total"], stat["pass_rate"] * 100))
    print("  成本合计 tokens_in=%s tokens_out=%s  总耗时 %.2fs" % (
        summary["tokens_in"], summary["tokens_out"], summary["latency_s_total"]))


def freeze_baseline(path, suite, tasks, role_name, args, rows, summary):
    path = Path(path)
    if path.exists() and not args.force:
        fail("baseline 已存在：%s（--force 覆盖重冻）" % path)
    payload = {
        "schema_version": BASELINE_SCHEMA_VERSION,
        "suite": suite["suite"],
        "suite_hash": suite_hash(tasks),
        "created_at": now_cn(),
        "role": role_name,
        "adapter": summary["adapter"],
        "judge": summary["judge"],
        "summary": summary,
        "rows": rows,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("[roster-bench] baseline 已冻结：%s（suite_hash=%s）" % (path, payload["suite_hash"][:12] + "…"))


def load_baseline(path):
    path = Path(path)
    if not path.is_file():
        fail("baseline 不存在：%s（先 --freeze 冻结）" % path)
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def compare(baseline, suite_name, tasks, rows, summary):
    if baseline.get("suite") != suite_name or baseline.get("suite_hash") != suite_hash(tasks):
        fail(
            "baseline 失效：任务集已变更（suite_hash 不一致）。baseline=%s current=%s\n"
            "任务集变更即 baseline 失效，请复检题目后重新 --freeze 冻结。"
            % (str(baseline.get("suite_hash"))[:12] + "…", suite_hash(tasks)[:12] + "…")
        )
    def mark(value):
        if value is None:
            return "—"
        return "✓" if value else "✗"

    old_rows = {r["task_id"]: r for r in baseline.get("rows", [])}
    improved = regressed = unchanged = 0
    print("== delta 报告（baseline %s @%s / adapter=%s judge=%s）==" % (
        baseline.get("suite"), baseline.get("created_at"), baseline.get("adapter"), baseline.get("judge")))
    for row in rows:
        old = old_rows.get(row["task_id"])
        if old is None:
            state = "新增"
        elif row["pass_overall"] and not old["pass_overall"]:
            state, improved = "↑ 改善", improved + 1
        elif old["pass_overall"] and not row["pass_overall"]:
            state, regressed = "↓ 回退", regressed + 1
        else:
            state, unchanged = "= 持平", unchanged + 1
        old_cell = "—" if old is None else "prog=%s judge=%s" % (
            mark(old["pass_programmatic"]),
            mark(old["pass_judge"]))
        print("  %-6s %-4s  旧[%s] → 新[prog=%s judge=%s]" % (
            row["task_id"], state, old_cell,
            mark(row["pass_programmatic"]), mark(row["pass_judge"])))
    old_summary = baseline.get("summary", {})
    old_at1 = old_summary.get("pass_at_1")
    print("-- 汇总 delta --")
    print("  pass@1: %s → %s（Δ%s）  改善=%d 回退=%d 持平=%d" % (
        old_at1, summary["pass_at_1"],
        "—" if old_at1 is None else round(summary["pass_at_1"] - old_at1, 4),
        improved, regressed, unchanged))
    print("  judge_unavailable: %s → %d" % (old_summary.get("judge_unavailable"), summary["judge_unavailable"]))
    print("  tokens_in: %s → %s   tokens_out: %s → %s" % (
        old_summary.get("tokens_in"), summary["tokens_in"],
        old_summary.get("tokens_out"), summary["tokens_out"]))


def main(argv=None):
    parser = argparse.ArgumentParser(description="roster-bench 基准线套件运行入口")
    parser.add_argument("--suite", default="baixiao", help="任务集名（bench/tasks/<name>.json）")
    parser.add_argument("--role", default="default", help="角色配置名或路径（bench/roles/）")
    parser.add_argument("--adapter", choices=["stub", "cli"], default="stub")
    parser.add_argument("--judge", choices=["stub", "api"], default="stub",
                        help="stub=镜像自测判官；api=kimi-for-coding 真语义判分（需 KIMI_CODE_API_KEY）")
    parser.add_argument("--baseline", help="baseline.json 路径：配合 --freeze 冻结，否则进入对比模式")
    parser.add_argument("--freeze", action="store_true", help="把本次结果冻结为 baseline")
    parser.add_argument("--force", action="store_true", help="覆盖已存在的 baseline")
    parser.add_argument("--replies", help="stub 回复集路径（默认 bench/stub_replies.json）")
    parser.add_argument("--profile", help="CliAdapter 用的 dsh profile 名（Task 11）")
    parser.add_argument("--out", help="把完整结果 JSON 另存到该路径")
    args = parser.parse_args(argv)

    if args.adapter == "cli":
        fail("cli 通道（dsh CLI headless）未接线：由 Task 11 提供参数与输出解析后启用", code=3)

    suite, _suite_path = load_suite(args.suite)
    tasks = suite["tasks"]
    role, role_name = load_role(args.role)

    # 对比模式先验 suite_hash 再跑卷：真机一卷是真金白银的 LLM 调用，不白跑。
    pending_baseline = None
    if args.baseline and not args.freeze:
        pending_baseline = load_baseline(args.baseline)
        if pending_baseline.get("suite") != suite["suite"] or pending_baseline.get("suite_hash") != suite_hash(tasks):
            fail(
                "baseline 失效：任务集已变更（suite_hash 不一致）。baseline=%s current=%s\n"
                "任务集变更即 baseline 失效，请复检题目后重新 --freeze 冻结。"
                % (str(pending_baseline.get("suite_hash"))[:12] + "…", suite_hash(tasks)[:12] + "…")
            )

    env = DocumentEnv(str(BENCH_ROOT / "env" / "documents")).load()
    adapter = build_adapter(args.adapter, args)
    judge = build_judge(args.judge)

    notes = []
    if args.judge == "stub":
        notes.append("judge=stub：语义 verdict 镜像程序化字面判定，仅用于管线自测，不代表真实语义判分")

    rows, summary = run_suite(tasks, adapter, judge, env, role)
    summary["suite"] = suite["suite"]
    summary["suite_hash"] = suite_hash(tasks)
    summary["role"] = role_name
    summary["created_at"] = now_cn()
    print_report(rows, summary, suite["suite"], role_name, notes)

    if args.out:
        Path(args.out).write_text(
            json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8")
        print("[roster-bench] 结果已写入：%s" % args.out)

    if args.baseline and args.freeze:
        freeze_baseline(args.baseline, suite, tasks, role_name, args, rows, summary)
    elif args.baseline:
        compare(pending_baseline, suite["suite"], tasks, rows, summary)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
