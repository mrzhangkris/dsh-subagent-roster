# roster-bench — 插件量化基准线套件（Python，零三方依赖）

tau-bench 范式：**任务集（instruction+outputs 判据）+ 双判分（程序化 scorers + LLM judge）+ harness + run_eval + baseline**。
无基准线处不能自动进化：本套件是插件的「进化前提」，全部产出**不依赖插件挂载**——派发通道抽象为 adapter，本任务以 StubAdapter 自测，CliAdapter 由 Task 11 接线后跑首卷并冻结 baseline。

## 结构

```
bench/
├── tasks/baixiao.json          # 8 题任务集（4 easy 检索 / 2 medium 跨文档 / 2 hard 多跳）
├── env/documents/              # 固定文档集冻结副本（判分客观性的锚；README.md 是来源清单）
├── scorers.py                  # 程序化判分：字面子串匹配 + 重放终态 diff（确定性，零模型调用）
├── judge.py                    # 语义判分：kimi-for-coding（stdlib urllib；不传 temperature）
├── adapters.py                 # Adapter 协议 + StubAdapter + CliAdapter(Task 11) + StubJudge/KimiJudge
├── harness.py                  # 跑测骨架与汇总（pass@1、分难度通过率、成本合计、suite_hash）
├── run_eval.py                 # CLI 入口（--suite/--role/--adapter/--judge/--baseline/--freeze）
├── roles/default.json          # 百晓生角色配置
├── stub_replies.json           # StubAdapter 自测回复集（锚定冻结文档）
├── baseline.example.json       # baseline 格式示例（真实 baseline.json 由 Task 11 首跑冻结）
└── tests/                      # stdlib unittest 单测（69 项）
```

## 命令

Python 一律 `/usr/bin/python3`：

```sh
# 全部单测
/usr/bin/python3 -m unittest discover -t bench -s bench/tests -v

# stub 全流程自测（零网络零模型）
/usr/bin/python3 bench/run_eval.py --suite baixiao --role default --adapter stub --judge stub

# 真语义判分（key 走环境变量 KIMI_CODE_API_KEY；不可用时该题标记 judge-unavailable，不静默 pass）
/usr/bin/python3 bench/run_eval.py --suite baixiao --role default --adapter cli --judge api

# 首跑冻结 baseline（Task 11）
/usr/bin/python3 bench/run_eval.py ... --baseline bench/baseline.json --freeze

# 对比模式（suite_hash 不一致会在跑卷前拒绝：任务集变更即 baseline 失效）
/usr/bin/python3 bench/run_eval.py ... --baseline bench/baseline.json
```

退出码：0 评测完成；2 操作错误（套件非法 / baseline 缺失或失效）；3 cli 通道未接线。

## 双判分维度

- **programmatic（scorers.py）**：outputs 中字符串项为字面量判据，大小写不敏感子串、空白归一后逐项检查，全部命中才过；任务带 `actions` 时在支持 `replay_actions(actions)->state` 的环境上重放终态并 diff（v1 文档环境无状态库，该维度自然跳过，框架为后续带环境任务预留）。
- **judge（judge.py）**：outputs 中 `{"semantic": ...}` 项交 kimi-for-coding 裁决，只输出 `{"verdict": "pass"|"fail", "reason"}`；失败重试 1 次；API/key 不可用 → 该题 `judge_status=unavailable`、`pass_overall=false`。payload **不含 temperature**（该模型只允许 temperature=1，任何显式值都会被端点拒绝）。
- overall = programmatic ∧ judge（judge 未需要时 = programmatic；judge 不可用时 = false）。

## baseline 语义

`--freeze` 写入 `{schema_version, suite, suite_hash, created_at(北京时间+08:00), role, adapter, judge, summary, rows}`。
`suite_hash` = 任务集 canonical JSON 的 sha256：**任务集任何内容变更（含 outputs 顺序）即 baseline 失效**，对比模式拒绝并要求复检后重冻。判分锚定 `env/documents` 冻结副本，上游文档变更不会使 baseline 失效。
