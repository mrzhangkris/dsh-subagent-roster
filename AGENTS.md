# Project maintenance notes

This repository is the `@mrzhangkris/dsh-subagent-roster` fork. The upstream plugin surface was removed in the identifier-separation refactor; verify exact Harness tags, npm artifacts, the resolved dependency graph, and subagent-roster behavior against the live host rather than historical docs. Historical evidence under `docs/` describes earlier maintenance rounds and is kept as record only.

User instructions and authorization take precedence over tooling defaults. Do not repeat confirmation for work the user has already authorized.

# Browser automation

For interactive browser automation, use the `ego-browser` skill from Ego Lite. Do not use `agent-browser` or another browser-control skill unless the user explicitly requests it or Ego Lite is unavailable.
