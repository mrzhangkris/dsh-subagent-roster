# @mrzhangkris/dsh-subagent-roster

> Fork 出处：本插件 fork 自 [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)（MIT），收敛为「具名子智能体花名册」。上游团队协作面已全部移除；本 fork 是标识符（patch id、状态命名空间、路由、命令、工具名）完全独立的插件。

<p align="right">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

DeepSeek Harness 的具名子智能体花名册插件：在设置中维护一份具名角色目录，任何会话都可以通过两个模型侧工具派单。

## 功能

- **`roster_list`** —— 列出已启用的角色（名称/图标/描述、模型策略、后台模式）。
- **`roster_agent`** —— 派单一个具名角色，走完整的 读取 → 解析 → 路由预检 → 派发 链路。`continuable` 角色成为持久子代理，可用 `send_message` 续派；`one-shot` 角色在工具结果中直接返回（`run_in_background=true` 转后台任务，用 `job_output` 读取）。
- **系统提示词花名册段** —— 静态使用协议 + 动态角色目录段，花名册变更后下一次请求即生效。
- **设置卡** —— 花名册维护在 `subagent-roster` 设置命名空间（设置 → 插件），Web GUI 有专属卡片。
- **`/roster <goal>`** —— 确定性激活面（斜杠命令 + 纯文本手势），把目标转成一次花名册派单。

## 安装

```sh
dsh plugin --profile web add @mrzhangkris/dsh-subagent-roster
```

安装后需重启该 profile 的 Harness 进程；新会话即可看到工具与提示词段。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm verify
```

基准套件（离线 stub 通道，零网络）在 `bench/`：

```sh
/usr/bin/python3 -m unittest discover -t bench -s bench/tests
```

## Fork 出处与许可

Fork 自上游 agent-teams 插件（MIT，Copyright (c) 2026 程序员阿江(Relakkes)），见 [LICENSE](./LICENSE)。上游的多代理团队面——团队工具、staged 计划、质量门禁、活动面板、内置技能——不属于本 fork。本项目携带自己的 MIT 许可修改。
