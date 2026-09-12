/** Stable, agent-scoped presentation. Business authority stays in the tools. */
import type { Context } from '@deepseek-ai/cordis'

/**
 * The model-facing roster usage policy. Static by design: the roster is a
 * settings-maintained directory, so the policy never rewrites itself, and
 * core instructions must stay available regardless of roster state. The
 * per-role directory is a separate dynamic section (`subagent-roster:roster`).
 */
export const ROSTER_USAGE_PROMPT = [
  'SubagentRoster protocol (named subagent roster):',
  '1. The roster is a named-role directory maintained in settings (设置→插件→子智能体花名册); the dynamic roster section lists the current roles, and roster_list re-reads them on demand. Dispatch roles with roster_agent.',
  '2. One dispatch = one named role with a self-contained prompt (the role\'s first-turn input). continuable roles are durable: continue them with send_message or wait for their report; one-shot roles answer in the tool result, and run_in_background=true turns them into a background job read with job_output.',
  '3. The role contract comes from the roster, not from the prompt: identity is icon+name, backgroundMode and model policy are fixed per role. Temporary tasks that fit no named role use the official subagent tools.',
  '4. Do not busy-poll: reports wake the parent automatically. After a roster change, re-check with roster_list instead of guessing role names.',
].join('\n')

/** The stable section name under the system-prompt registry. */
export const ROSTER_USAGE_SECTION_NAME = 'subagent-roster:usage'

interface CapabilityConfig {
  /** Prompt-section order for the usage policy (default `117`). */
  order?: number
}

/**
 * Register the static roster usage section. Plain presentation only: the
 * section text is fixed at install time, and roster state never rewrites it.
 */
export function installRosterCapabilities(ctx: Context, config: CapabilityConfig = {}): void {
  ctx.systemPrompt.section({
    name: ROSTER_USAGE_SECTION_NAME,
    order: config.order ?? 117,
    text: () => ROSTER_USAGE_PROMPT,
  })
}
