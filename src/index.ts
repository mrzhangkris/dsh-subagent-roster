/**
 * SubagentRoster for DeepSeek Harness.
 *
 * A host-plane plugin forked from the upstream team plugin and narrowed to
 * a named subagent roster (fork provenance: see README): it registers the `roster_list`/`roster_agent` tools, one
 * agent-scoped usage section, and one dynamic roster-directory section. The
 * roster itself lives in the settings namespace `subagent-roster` and is
 * maintained from the settings card; dispatch goes straight through the
 * host subagent providers (no team state, no scheduler, no task DAG).
 *
 * Installation (bundle): `dsh plugin --profile <name> add @mrzhangkris/dsh-subagent-roster`
 * (or a local path). The bundle patch mounts this plugin row into the host
 * composition; the tools register into the shared `tools` registry and the
 * usage section into the global system prompt, so the plugin needs no realm.
 *
 * @module dsh-subagent-roster
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merges make ctx.subagents and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerRosterTools } from './tools.ts'
import { registerRosterCommand, installRosterGestureBoundary } from './command.ts'
import { registerRosterSettings, getRoster } from './settings.ts'
import { buildRosterSection, ROSTER_SECTION_NAME, ROSTER_SECTION_ORDER } from './section.ts'
import { installRosterCapabilities } from './capabilities.ts'

export const name = 'subagent-roster'
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt']

/** Plugin configuration. */
export interface Config {
  /** Prompt-section order for the usage policy (default `117`). */
  promptSectionOrder?: number
  /**
   * Register the deterministic `/roster` activation surfaces (the
   * closed-namespace slash command and the plain-text gesture boundary).
   * Disable to keep the natural-language trigger as the only entry point.
   */
  slashCommand?: boolean
}

/** The plugin configuration schema. */
export const Config: z<Config> = z.object({
  promptSectionOrder: z.natural().default(117),
  slashCommand: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config): void {
  // Roster model-facing tools (roster_list + roster_agent): the dispatch
  // chain reads `ctx.llm` (route resolution) and `ctx.subagents` (the
  // transport capability gate — the Task 7 fail-closed dependency) through
  // the closed-over context at execute time; `ctx.jobs` is read via
  // `ctx.get('jobs')` so a headless profile without it keeps every other
  // path functional.
  registerRosterTools(ctx)

  // Roster settings namespace (`subagent-roster`) + hot read entry point:
  // dispatch and the settings card read the roster through getRoster(), which
  // re-reads the current settings source on every call. Optional seam: the
  // plugin keeps working (composition-entry roster) when no settings provider
  // is mounted.
  registerRosterSettings(ctx, config)

  // Dynamic roster directory section: the text callback is evaluated at
  // EVERY prompt assembly, so a committed roster change is visible on the
  // next request with no manual refresh (no onRosterChange subscription
  // needed). An empty roster renders '' — the registry drops empty sections.
  ctx.systemPrompt.section({
    name: ROSTER_SECTION_NAME,
    order: ROSTER_SECTION_ORDER,
    text: () => {
      const read = getRoster()
      if (!read.ok) return ''
      return buildRosterSection(read.roster)?.text ?? ''
    },
  })

  // Static usage policy section (roster semantics): when and how to drive
  // the roster, ahead of the dynamic directory section.
  installRosterCapabilities(ctx, { order: config.promptSectionOrder })

  // Deterministic activation surfaces: the closed-namespace `/roster`
  // host command (surfaces in the Web GUI slash menu via the Harness
  // ui-commands client) and the plain-text gesture boundary for surfaces
  // without command adjudication (headless CLI). Both default on; a profile
  // can disable them to keep the natural-language trigger exclusive.
  //
  // `commands` is registered lazily (not a required inject): it ships in the
  // base bundle of every standard profile, but a minimal composition that
  // omits the command registry keeps the plugin fully functional — the fiber
  // never pends on it and simply never gains the slash command.
  if (config.slashCommand ?? true) {
    ctx.inject(['commands'], (commandCtx) => {
      registerRosterCommand(commandCtx)
    })
    installRosterGestureBoundary(ctx)
  }
}
