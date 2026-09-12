/**
 * The roster model-facing tools: `roster_list` + `roster_agent`.
 *
 * The full dispatch link lives here: settings read (getRoster) → resolve
 * (resolveAgent) → route preflight (preflightRoute with `capabilities`
 * injected from the host `ctx.subagents`) → dispatch (dispatch.ts). Every
 * mapped failure is surfaced by THROWING a messageed Error — the DSH tool
 * registry materializes thrown tool errors as `isError` results whose text
 * carries the message (the same convention the official tools use).
 * The single exception is the parent defense (missing `exec.agent`), which
 * throws directly like the dispatch modules' own line of defense.
 *
 * Narrowed from the upstream fork: the upstream team tool surface
 * (create/edit-plan/approve, member lifecycle, tasks, mailboxes, staged
 * plans, quality gates) has been removed — this plugin is a pure named-roster
 * dispatch face over the host subagent providers.
 * @module dsh-subagent-roster/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { getRoster } from './settings.ts'
import { resolveAgent } from './roster.ts'
import { preflightRoute } from './route.ts'
import { dispatchContinuable, dispatchOneShotBackground, dispatchOneShotForeground } from './dispatch.ts'
import { modelPolicyBadge } from './section.ts'
import type { RosterRead } from './roster-read.ts'

/* ---------------------------------------------------------------------- *
 * Roster tools (roster_list + roster_agent).
 * ---------------------------------------------------------------------- */

/** The canonical roster_list entry shape. */
export interface RosterListEntry {
  name: string
  icon?: string
  description: string
  modelPolicy: string
  /** Present only under modelPolicy=fixed (the badge needs it). */
  model?: string
  backgroundMode: string
}

/** Tool-facing summary of a failed roster read (mirrors roster.ts wording). */
function rosterUnavailableMessage(read: RosterRead): string {
  if (read.ok) return '花名册可用' // unreachable: callers check `read.ok` first
  if ('readonly' in read) {
    return '花名册不可用：存储的 schemaVersion 比本构建更新，roster loads read-only —— 请升级插件后再派单'
  }
  const summary = read.errors.map(issue => `${issue.path === '' ? 'root' : issue.path}: ${issue.msg}`).join('; ')
  return `花名册不可用：corrupted roster — ${summary}`
}

/** R5 audit clause: inherit-fallback warnings must stay visible in the result. */
function withRouteNotes(text: string, notes: readonly string[] | undefined): string {
  if (notes === undefined || notes.length === 0) return text
  return `${text}\n\n⚠️ 路由提示：\n${notes.map(note => `- ${note}`).join('\n')}`
}

/** Render the roster_list canonical value as compact model text. */
export function renderRosterList(value: JsonValue): string {
  const entries = value as unknown as RosterListEntry[]
  if (!Array.isArray(entries) || entries.length === 0) {
    return '花名册为空，请到设置→插件→子智能体花名册维护。'
  }
  return [
    `当前可用花名册角色（${entries.length}）：`,
    ...entries.map(entry => (
      `- ${entry.icon === undefined || entry.icon === '' ? '' : `${entry.icon} `}${entry.name}——${entry.description}`
      + `（模型: ${modelPolicyBadge(entry as { modelPolicy: 'inherit' | 'fixed' | 'auto'; model?: string })}/后台: ${entry.backgroundMode}）`
    )),
  ].join('\n')
}

/** Render the roster_agent canonical value as the model-facing result text. */
export function renderRosterAgentResult(value: JsonValue): string {
  const result = value as {
    dispatched: string
    agent: string
    child_id?: string
    job_id?: string
    text?: string
    detail?: string
    notes?: string[]
  }
  let text: string
  if (result.dispatched === 'continuable') {
    text = `角色「${result.agent}」已启动（childId ${result.child_id}），可用 send_message 续派或等其回报。`
  } else if (result.dispatched === 'one-shot-background') {
    text = `角色「${result.agent}」已在后台启动（jobId ${result.job_id}）：用 job_output 读取结果，job_kill 可停止。`
  } else {
    text = `角色「${result.agent}」已返回：\n${result.text ?? ''}`
    if (result.detail !== undefined) text += `\n(备注: ${result.detail})`
  }
  return withRouteNotes(text, result.notes)
}

/**
 * Register the roster model-facing tools: `roster_list` (the enabled role
 * directory) and `roster_agent` (dispatch one named role through the full
 * read → resolve → preflight → dispatch chain). Called from the plugin
 * `apply`; the host surfaces (`ctx.llm`, `ctx.subagents`, `ctx.jobs`) are
 * read through the closed-over context at execute time, so a headless
 * profile without the jobs service keeps the other paths functional.
 * @param ctx - the plugin context.
 */
export function registerRosterTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'roster_list',
    description: 'List the enabled named roster roles (name/icon/description/model policy/background mode). Use it to pick a roster_agent target, or whenever unsure which roles exist. An empty roster means the user has not configured roles yet.',
    parameters: {},
    output: {
      schema: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
      render: (_args, value) => [{ type: 'text', text: renderRosterList(value) }],
    },
    async execute() {
      // Three-state read: healthy → enabled directory; corrupted/readonly →
      // the thrown message becomes the isError summary.
      const read = getRoster()
      if (!read.ok) throw new Error(rosterUnavailableMessage(read))
      return read.roster.agents
        .filter(agent => agent.enabled)
        .map(agent => ({
          name: agent.name,
          ...(agent.icon !== undefined && agent.icon !== '' ? { icon: agent.icon } : {}),
          description: agent.description,
          modelPolicy: agent.modelPolicy,
          ...(agent.modelPolicy === 'fixed' ? { model: agent.model } : {}),
          backgroundMode: agent.backgroundMode,
        }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roster_agent',
    description: '具名角色派单（dispatch a named roster role）。临时任务（无需花名册角色）用官方 subagent 工具；不确定有哪些角色先调 roster_list。'
      + 'continuable 角色常驻：启动后可用 send_message 续派或等其回报；one-shot 角色默认前台等待结果，run_in_background=true 转后台任务（用 job_output 读取）。'
      + 'run_in_background 对 continuable 角色无效（静默忽略）——角色的 backgroundMode 是契约。无 description 参数：角色身份固定为「icon+name」。',
    parameters: {
      agent: { type: 'string', required: true, description: '花名册角色名（roster_list 可查）。' },
      prompt: { type: 'string', required: true, description: '发给该角色的任务提示（其首个 turn 的输入）。' },
      run_in_background: { type: 'boolean', description: '仅 one-shot 角色有效：后台执行并用 job_output 读取结果；continuable 角色静默忽略此参数。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: renderRosterAgentResult(value) }],
    },
    async execute(args, exec) {
      // Step 1 — parent defense (the one unmapped throw): dispatching needs
      // the live parent Agent, exactly like the dispatch modules' contract.
      const parent = exec.agent
      if (!parent) {
        throw new Error('roster_agent requires a calling agent (exec.agent was undefined); this tool can only run from inside an agent turn')
      }

      // Step 2 — three-state roster read; a corrupted/readonly roster fails
      // CLOSED with an actionable summary (never a silent empty-roster
      // fallback).
      const read = getRoster()
      if (!read.ok) throw new Error(rosterUnavailableMessage(read))

      // Step 3 — resolve the role. not-found carries the enabled `available`
      // list so the model can self-correct; disabled is a distinct failure.
      const resolved = resolveAgent(read.roster, args.agent)
      if (!resolved.ok) {
        if (resolved.code === 'roster-unavailable') throw new Error(resolved.detail)
        const available = resolved.available.length === 0 ? '（当前没有启用角色）' : resolved.available.join('、')
        if (resolved.code === 'disabled') {
          throw new Error(`角色「${args.agent}」已停用。可用角色：${available}`)
        }
        throw new Error(`花名册中没有角色「${args.agent}」。可用角色：${available}`)
      }
      const spec = resolved.spec

      // Step 4 — route preflight. `capabilities` MUST be the host
      // `ctx.subagents` service: the Task 7 fail-closed gate depends on this
      // injection (a knob-carrying spec with no capability surface must fail
      // loudly, never silently skip the gate). Fallback notes ride an
      // inherit-fallback success and are appended to every result text (R5).
      const preflight = await preflightRoute(
        { llm: ctx.llm, capabilities: ctx.subagents },
        { transport: read.roster.transport, spec },
      )
      if (!preflight.ok) throw new Error(preflight.error)
      const notes = preflight.notes

      // Step 5 — dispatch by the role's backgroundMode contract.
      if (spec.backgroundMode === 'continuable') {
        // Step 6 — `run_in_background` is silently ignored here: a
        // continuable role is durable by contract and the flag cannot
        // downgrade it.
        const started = await dispatchContinuable(
          { subagents: ctx.subagents },
          { agent: parent, transport: read.roster.transport, spec, prompt: args.prompt, signal: exec.signal },
        ).catch((error: unknown) => {
          throw new Error(`角色「${spec.name}」派单失败：${String(error)}`)
        })
        return {
          dispatched: 'continuable',
          agent: spec.name,
          label: spec.label,
          child_id: started.childId,
          message_id: started.messageId,
          ...(notes === undefined ? {} : { notes }),
        }
      }

      if (args.run_in_background === true) {
        const started = (() => {
          try {
            return dispatchOneShotBackground(
              { subagents: ctx.subagents, jobs: ctx.get('jobs') },
              { agent: parent, transport: read.roster.transport, spec, prompt: args.prompt, signal: exec.signal },
            )
          } catch (error) {
            throw new Error(`角色「${spec.name}」后台派单失败：${String(error)}`)
          }
        })()
        return {
          dispatched: 'one-shot-background',
          agent: spec.name,
          label: spec.label,
          job_id: started.jobId,
          ...(notes === undefined ? {} : { notes }),
        }
      }

      const settled = await dispatchOneShotForeground(
        { subagents: ctx.subagents },
        { agent: parent, transport: read.roster.transport, spec, prompt: args.prompt, signal: exec.signal },
      )
      if (!settled.ok) {
        throw new Error(`${settled.errorTitle}\n${settled.detail}`)
      }
      return {
        dispatched: 'one-shot-foreground',
        agent: spec.name,
        label: spec.label,
        text: settled.text,
        ...(settled.detail === undefined ? {} : { detail: settled.detail }),
        ...(notes === undefined ? {} : { notes }),
      }
    },
  }))
}
