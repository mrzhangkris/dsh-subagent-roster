/**
 * Dynamic roster section for the system prompt (Task 8, part A).
 *
 * `buildRosterSection` renders the CURRENT roster as a model-facing directory:
 * one line per enabled role (icon/name/description plus the model-policy and
 * background-mode badges), framed by the fixed header and dispatch guidance.
 * The function is PURE — it validates nothing and reads nothing; the caller
 * feeds it the validated `RosterConfig` from `getRoster()`.
 *
 * The section is evaluated at every prompt ASSEMBLY (the fork's
 * `systemPrompt.section` text callback), so a committed roster change is
 * visible on the next request with no manual refresh and no change
 * subscription. An empty roster returns `null` and the caller skips the
 * registration content entirely.
 *
 * The badge vocabulary is shared with the `roster_list` tool's renderer
 * (`modelPolicyBadge`), so the system prompt and the tool result always
 * describe the same role the same way.
 * @module dsh-subagent-roster/section
 */

import type { RosterAgent, RosterConfig } from './schema.ts'

/** The stable section name under the system-prompt registry. */
export const ROSTER_SECTION_NAME = 'subagent-roster:roster'

/** Default order: directly after the AgentTeams usage policy section (117). */
export const ROSTER_SECTION_ORDER = 118

/**
 * The model-policy badge for one role: inherit→「继承主模型」、
 * fixed→「固定 <model>」、auto→「auto」. Shared with the roster_list render.
 */
export function modelPolicyBadge(agent: Pick<RosterAgent, 'modelPolicy' | 'model'>): string {
  if (agent.modelPolicy === 'fixed') return `固定 ${agent.model ?? ''}`
  if (agent.modelPolicy === 'auto') return 'auto'
  return '继承主模型'
}

/** The background-mode half of a roster line badge. */
function backgroundBadge(agent: Pick<RosterAgent, 'backgroundMode'>): string {
  return agent.backgroundMode
}

/** Render one enabled role as a single directory line. */
function rosterLine(agent: RosterAgent): string {
  const icon = agent.icon && agent.icon.length > 0 ? `${agent.icon} ` : ''
  return `- ${icon}${agent.name}——${agent.description}（模型: ${modelPolicyBadge(agent)}/后台: ${backgroundBadge(agent)}）`
}

/**
 * Build the roster directory section. Returns `null` when the roster has no
 * enabled role — the caller must not register an empty section.
 */
export function buildRosterSection(roster: RosterConfig): { name: string; text: string } | null {
  const enabled = roster.agents.filter(agent => agent.enabled)
  if (enabled.length === 0) return null
  const text = [
    '当前花名册角色（设置→插件→子智能体花名册可维护）：',
    ...enabled.map(rosterLine),
    '派具名角色用 roster_agent 工具；临时任务用官方 subagent；不确定派谁先调 roster_list。',
  ].join('\n')
  return { name: ROSTER_SECTION_NAME, text }
}
