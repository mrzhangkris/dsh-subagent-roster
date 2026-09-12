# env/documents — 固定文档集（判分客观性的锚）

基准内容自持：8 题任务集（`bench/tasks/baixiao.json`）的全部答案都可从本目录的冻结副本中得出。
判分只锚定这些副本，不锚定仓库实时文件——上游文档后续变更不会使 baseline 失效，任务集变更才会。

| 冻结文件 | 来源（仓库内路径） | 冻结时间 | 仓库 HEAD |
| --- | --- | --- | --- |
| README_ZH.md | `README_ZH.md` | 2026-09-12 | `e28a6a6c331f506758be84c11728cb42bd64a68c` |
| usage.md | `docs/usage.md` | 2026-09-12 | 同上 |
| progressive-loading.md | `docs/progressive-loading.md` | 2026-09-12 | 同上 |
| verification-guide.md | `docs/verification-guide.md` | 2026-09-12 | 同上 |

规则：

- 副本内容逐字节来自冻结时刻的仓库文件，禁止手改；更新文档集 = 重新复制 + 更新本清单 + 任务集随动复检 + baseline 失效重冻。
- 派发 prompt 默认注入全部文档（`env.py: DocumentEnv.compose_prompt`），题目不作文档子集裁剪。
- v1 环境仅文档集、无状态库：任务 `actions` 留空，重放维度由 scorers 自然跳过（框架预留）。
