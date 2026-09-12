# @mrzhangkris/dsh-subagent-roster

> Fork provenance: this plugin is forked from [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) (MIT) and narrowed to a named subagent roster. All upstream team tooling has been removed; the fork is an independent plugin with its own identifiers (patch id, state namespace, routes, command, and tool names).

<p align="right">
  <strong>English</strong> · <a href="./README_ZH.md">简体中文</a>
</p>

A named subagent roster plugin for DeepSeek Harness: maintain a directory of named roles in settings, then dispatch them from any session through two model-facing tools.

## What it does

- **`roster_list`** — lists the enabled roles (name/icon/description, model policy, background mode).
- **`roster_agent`** — dispatches one named role through the full read → resolve → route-preflight → dispatch chain. `continuable` roles become durable subagents you can continue with `send_message`; `one-shot` roles answer in the tool result (`run_in_background=true` turns them into a background job read with `job_output`).
- **Roster sections in the system prompt** — a static usage policy plus a dynamic role directory that re-renders on every prompt assembly after a roster change.
- **Settings card** — the roster is maintained under the `subagent-roster` settings namespace (Settings → Plugins), with a dedicated card in the Web GUI.
- **`/roster <goal>`** — a deterministic activation surface (slash command plus plain-text gesture) that turns a goal into a roster dispatch.

## Install

```sh
dsh plugin --profile web add @mrzhangkris/dsh-subagent-roster
```

Restart the profile's Harness process after installing; the tools and sections appear on the next session.

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm verify
```

The bench suite (offline stub channel, zero network) lives in `bench/`:

```sh
/usr/bin/python3 -m unittest discover -t bench -s bench/tests
```

## Fork provenance & license

Forked from the upstream agent-teams plugin (MIT, Copyright (c) 2026 程序员阿江(Relakkes)); see [LICENSE](./LICENSE). The upstream multi-agent team surface — team tools, staged plans, quality gates, activity panel, and vendored skills — is not part of this fork. This project carries its own MIT-licensed modifications.
