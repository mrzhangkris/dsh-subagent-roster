/**
 * SubagentRoster for DeepSeek Harness.
 *
 * A host-plane plugin forked from agent-teams and narrowed to a named
 * subagent roster: it registers the `agent_teams_*` member-management tools
 * and one agent-scoped usage section. Members are durable continuable
 * subagents of the captain session; tasks are plain status records and the
 * captain assigns work through messages (no shared scheduler, no task DAG,
 * no quality gates).
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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Declaration merges make ctx.subagents and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import {
  haltTeamWork,
  stagedPlanApprovedContext,
  registerAgentTeamsTools,
  registerRosterTools,
  type StagedPlanMutation,
  type ToolsConfig,
} from './tools.ts'
import { installAgentTeamsGestureBoundary, registerAgentTeamsCommand } from './command.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectArchivedTeamsActivity, collectTeamsActivity } from './snapshot.ts'
import { findTeamByCaptain } from './state.ts'
import { formatProfilesForPrompt, type TeamProfileConfig } from './profiles.ts'
import { installTeamCapabilities } from './capabilities.ts'
import { registerRosterSettings, getRoster } from './settings.ts'
import { buildRosterSection, ROSTER_SECTION_NAME, ROSTER_SECTION_ORDER } from './section.ts'
import { TEAM_TOOL_NAMES } from './tool-names.ts'

import { authenticatedWebRoutes, readJsonRequest, RequestBodyError, type BrowserRequestGate, type WebRouteHost } from './web-routes.ts'

/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const

export const name = 'agent-teams'
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents']

/** Plugin configuration. */
export interface Config {
  /**
   * State directory name under the captain's workspace; team state lives at
   * `<workspace>/<stateDir>/<teamId>/` (default `.agent-teams`).
   */
  stateDir?: string
  /** `ctx.subagents` provider used to spawn members; must support continuable children and personas (default `spawn`). */
  memberProvider?: string
  /** Optional model override applied to every member. */
  memberModel?: string
  /** Prompt injected into member personas and automatic task assignments. */
  executionPrompt?: string
  /** Plugin-wide fallback route for unavailable member models. */
  fallback?: import('./profiles.ts').TeamModelFallbackConfig
  /** Member delegation depth cap (default `1`; `0` forbids delegation entirely). */
  memberMaxDepth?: number
  /** Team size cap in members (default `8`). */
  maxMembers?: number
  /** Named multi-role team profiles. */
  profiles?: Record<string, TeamProfileConfig>
  /** Prompt-section order for the usage policy (default `117`, after delegation policy). */
  promptSectionOrder?: number
  /**
   * Register the deterministic `/agent-teams` activation surfaces (the
   * closed-namespace slash command and the plain-text gesture boundary).
   * Disable to keep the natural-language trigger as the only entry point.
   */
  slashCommand?: boolean
}

// `z.object()` has an implicit `{}` default in Schemastery.  Fallback routes
// are optional, so model absence explicitly; otherwise a missing route is
// validated as an empty object and fails on the required provider/model keys.
const fallbackRouteConfig = z.union([
  z.object({ provider: z.string().required(), model: z.string().required() }),
  z.const(undefined),
])

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.agent-teams'),
  memberProvider: z.string().default('spawn'),
  memberModel: z.string(),
  executionPrompt: z.string(),
  fallback: fallbackRouteConfig,
  profiles: z.dict(z.object({
    description: z.string(),
    protocol: z.string(),
    executionPrompt: z.string(),
    fallback: fallbackRouteConfig,
    members: z.array(z.object({
      name: z.string().required(),
      role: z.string(),
      provider: z.string(),
      model: z.string(),
      reasoning_effort: z.string(),
      executionPrompt: z.string(),
      fallback: fallbackRouteConfig,
    })).min(1).required(),
  })).default({}),
  memberMaxDepth: z.natural().default(1),
  maxMembers: z.natural().min(1).default(8),
  promptSectionOrder: z.natural().default(117),
  slashCommand: z.boolean().default(true),
})

/** The model-facing usage policy: when and how to drive SubagentRoster. */
export function usageSectionText(toolNames: string, profilesText = ''): string {
  return `SubagentRoster captain protocol (named subagent roster, narrowed from AgentTeams):
1. Inspect current team state when needed, using agent_teams_status. Continue existing work without duplicating its roster. Create only when no current team exists, with the user's goal as description and approval="required"; automatic approval requires an explicit request to run immediately. Staged plans never spawn members.
2. Add each needed role once; members inherit your model route unless another is requested/needed. A requested profile goes to create({profile}); it supplies its member roster. Do not duplicate it.
3. Stage the smallest useful roster. Every task needs a subject; keep tasks plain status records. Present the plan and end your turn for review; never approve in that planning turn. Approve only after a later explicit user approval or the Web action.
4. Respect Web approve/return/discard control messages. On return, ask what to change before editing; after the answer, use one atomic agent_teams_edit_plan batch, summarize and await review again. Never inspect or edit .agent-teams state files or plugin source code to revise plans. Discard does not authorize a replacement.
5. There is no automatic scheduler: you are the dispatcher. Assign work with agent_teams_create_task (optionally assignee) plus agent_teams_send_message to the member; one open task per member. Handle reports/user work, then yield when waiting is all that remains: member messages wake you automatically. Use status after a delivery or user request, never busy-poll or wait for unassigned members.
6. Members mark their assigned task in_progress, then completed or failed with a concise output, and report to you with send_message. Terminal tasks are immutable; create a follow-up task instead of editing them.
7. Halted means the user stopped work (including the captain turn). Resume only on a later explicit user request with a reason, via agent_teams_resume. Member lifecycle events (working/idle, failures, reports) are recorded for you; do not pause or interrupt members on your own.
8. Wait for members to become idle and their tasks terminal, present results, then archive the team with agent_teams_delete unless the user wants to continue. Never discard unfinished work without authorization.
Tools: ${toolNames}${profilesText === '' ? '' : `\n\n${profilesText}`}`
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ToolsConfig = {
    stateDir: config.stateDir ?? '.agent-teams',
    memberProvider: config.memberProvider ?? 'spawn',
    memberModel: config.memberModel,
    executionPrompt: config.executionPrompt,
    fallback: config.fallback,
    memberMaxDepth: config.memberMaxDepth ?? 1,
    maxMembers: config.maxMembers ?? 8,
    profiles: config.profiles ?? {},
  }

  // Provider registration is a sibling plugin's effect (`subagent-spawn` /
  // `subagent-fork` rows), which can land after this mount under the Loader's
  // concurrent activation — so capability validation happens at the first
  // member spawn (`spawnMember`), the earliest point the provider list is
  // settled, rather than here.

  const agentTeamsRuntime = registerAgentTeamsTools(ctx, resolved)

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

  installTeamCapabilities(ctx, {
    stateDir: resolved.stateDir,
    isPendingMember: agentTeamsRuntime.isPendingMember,
    order: config.promptSectionOrder,
    // Keep the bounded profile directory available without extra tool calls.
    // installTeamCapabilities snapshots this once; no business state rewrites it.
    captainPrompt: () => usageSectionText(TEAM_TOOL_NAMES.join(', '), formatProfilesForPrompt(config.profiles)),
  })

  // Deterministic activation surfaces: the closed-namespace `/agent-teams`
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
      registerAgentTeamsCommand(commandCtx, () => config.profiles ?? {})
    })
    installAgentTeamsGestureBoundary(ctx, () => config.profiles ?? {})
  }

  // The activity panel data/artwork routes need the Web server and the
  // workspace registry, which headless profiles do not mount; under
  // concurrent activation they may also bind after this plugin. Register the
  // routes lazily: try now, then on each service binding event. In a webless
  // profile the plugin stays tool-only and never blocks boot.
  let webRegistered = false
  const registerWebSurface = (): void => {
    if (webRegistered) return
    const rawWebServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])) as WebRouteHost | undefined
    const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as WorkspaceRegistry | undefined
    if (rawWebServer === undefined || workspaceRegistry === undefined) return
    const webServer = authenticatedWebRoutes(rawWebServer, () => ctx.get('connection') as BrowserRequestGate | undefined)
    webRegistered = true

    // Activity panel data route: the browser floater polls this for team
    // snapshots (disk truth + live subagent activity). Mirrors the Claude
    // Code desktop watcher's server-side snapshot pattern.
    ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-agent-teams/state',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const roots = workspaceRegistry.list().map((workspace) => ({
        workspace: workspace.title,
        stateRoot: join(workspace.path, resolved.stateDir),
      }))
      // ?archived=1 serves teams moved to archive/ (post-delete review).
      const snapshots = url.searchParams.get('archived') === '1'
        ? await collectArchivedTeamsActivity(ctx, roots)
        : await collectTeamsActivity(ctx, roots)
      const body = JSON.stringify({ teams: snapshots })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(body)
    },
  }), 'agent-teams: activity route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-teams/halt',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
          res.end()
          return
        }
        let payload: Record<string, unknown>
        try {
          payload = await readJsonRequest(req)
        } catch (error: unknown) {
          res.writeHead(error instanceof RequestBodyError ? error.status : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request body' }))
          return
        }
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
        const teamId = typeof payload.teamId === 'string' ? payload.teamId.trim() : ''
        if (sessionId === '' || teamId === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'sessionId and teamId are required' }))
          return
        }
        const captain = ctx.agents.get(sessionId as import('@deepseek-ai/dsh-session').SessionId)
        if (captain === undefined) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'captain session is not attached' }))
          return
        }
        const workspace = captain.session.header.cwd ?? process.cwd()
        const stateRoot = join(workspace, resolved.stateDir)
        const team = await findTeamByCaptain(stateRoot, captain.id)
        if (team === undefined || team.id !== teamId) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'team not found for this captain' }))
          return
        }
        try {
          const result = await haltTeamWork({
            ctx,
            stateRoot,
            teamId,
            captain,
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(result))
        } catch (error: unknown) {
          ctx.logger.warn(`agent-teams: halt failed for ${teamId}: ${String(error)}`)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'failed to stop the team' }))
        }
      },
    }), 'agent-teams: halt route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-teams/plan',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
          res.end()
          return
        }
        let payload: Record<string, unknown>
        try {
          payload = await readJsonRequest(req)
        } catch (error: unknown) {
          res.writeHead(error instanceof RequestBodyError ? error.status : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request body' }))
          return
        }
        const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'].trim() : ''
        const teamId = typeof payload['teamId'] === 'string' ? payload['teamId'].trim() : ''
        const action = typeof payload['action'] === 'string' ? payload['action'] : ''
        if (sessionId === '' || teamId === '' || action === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'sessionId, teamId, and action are required' }))
          return
        }
        const captain = ctx.agents.get(sessionId as import('@deepseek-ai/dsh-session').SessionId)
        if (captain === undefined) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'captain session is not attached' }))
          return
        }
        const workspace = captain.session.header.cwd ?? process.cwd()
        const stateRoot = join(workspace, resolved.stateDir)
        const team = await findTeamByCaptain(stateRoot, captain.id)
        if (team === undefined || team.id !== teamId) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'team not found for this captain' }))
          return
        }
        try {
          if (action === 'approve') {
            const approved = await agentTeamsRuntime.approveStagedTeam(captain, teamId)
            // The browser receives the HTTP result, so the model needs its own
            // control message. steer wakes an idle captain or joins its next
            // step; the tool approve path already returns to the model itself.
            try {
              captain.steer(createUserMessage({
                content: [{ type: 'text', text: stagedPlanApprovedContext(team.name) }],
                source: { kind: 'plugin', plugin: 'dsh-agent-teams' },
              }))
            } catch (error) {
              // Approval is already committed. Do not report a failed approval
              // and invite a retry that could duplicate the user's action.
              ctx.logger.warn(`agent-teams: approval notification failed for ${teamId}: ${String(error)}`)
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, phase: 'running', ...approved }))
            return
          }
          if (action === 'continue') {
            const continued = await agentTeamsRuntime.continueStagedPlanning(captain, teamId)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, phase: 'staged', review: 'awaiting_feedback', ...continued }))
            return
          }
          if (action === 'discard') {
            const discarded = await agentTeamsRuntime.discardStagedTeam(captain, teamId)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, phase: 'archived', ...discarded }))
            return
          }
          let mutation: StagedPlanMutation
          if (action === 'update_member') {
            if (typeof payload['memberName'] !== 'string'
              || typeof payload['provider'] !== 'string'
              || typeof payload['model'] !== 'string') throw new Error('memberName, provider, and model are required')
            mutation = {
              action,
              memberName: payload['memberName'],
              provider: payload['provider'],
              model: payload['model'],
              ...typeof payload['role'] === 'string' || payload['role'] === null ? { role: payload['role'] as string | null } : {},
              ...typeof payload['reasoningEffort'] === 'string' || payload['reasoningEffort'] === null
                ? { reasoningEffort: payload['reasoningEffort'] as string | null }
                : {},
              ...typeof payload['executionPrompt'] === 'string' || payload['executionPrompt'] === null
                ? { executionPrompt: payload['executionPrompt'] as string | null }
                : {},
            }
          } else if (action === 'update_task') {
            if (typeof payload['taskId'] !== 'string' || typeof payload['subject'] !== 'string') {
              throw new Error('taskId and subject are required')
            }
            mutation = {
              action,
              taskId: payload['taskId'],
              subject: payload['subject'],
              ...typeof payload['description'] === 'string' || payload['description'] === null
                ? { description: payload['description'] as string | null }
                : {},
              ...typeof payload['assignee'] === 'string' || payload['assignee'] === null
                ? { assignee: payload['assignee'] as string | null }
                : {},
            }
          } else if (action === 'add_task') {
            if (typeof payload['subject'] !== 'string') throw new Error('subject is required')
            mutation = {
              action,
              subject: payload['subject'],
              ...typeof payload['description'] === 'string' || payload['description'] === null
                ? { description: payload['description'] as string | null }
                : {},
              ...typeof payload['assignee'] === 'string' || payload['assignee'] === null
                ? { assignee: payload['assignee'] as string | null }
                : {},
            }
          } else if (action === 'remove_task') {
            if (typeof payload['taskId'] !== 'string') throw new Error('taskId is required')
            mutation = { action, taskId: payload['taskId'] }
          } else {
            throw new Error(`unknown plan action "${action}"`)
          }
          const updated = await agentTeamsRuntime.updateStagedPlan(captain, teamId, mutation)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, phase: updated.phase, members: updated.members.length, tasks: updated.tasks.length }))
        } catch (error: unknown) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'plan operation failed' }))
        }
      },
    }), 'agent-teams: plan route')

  // Whale mascot artwork: serve the packaged V2 role/action images to the
  // activity panel. An explicit allowlist guards the route (no path
  // traversal); the images ship with the bundle (files: assets/).
  const artDir = fileURLToPath(new URL('../assets/agent-teams/', import.meta.url))
  const ART_ALLOWLIST = new Set([
    'team-lead-v2.png',
    'member-researcher-v2.png', 'member-engineer-v2.png',
    'member-qa-v2.png', 'member-designer-v2.png',
    'member-security-v2.png', 'member-docs-v2.png',
    'member-data-v2.png', 'member-operator-v2.png',
    'action-working-v2.png', 'action-thinking-v2.png',
    'action-reporting-v2.png', 'action-celebrating-v2.png',
    'action-sleeping-v2.png', 'action-sending-v2.png',
  ])
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/plugins/dsh-agent-teams/assets',
    handler: async (req, res) => {
      let name: string
      try {
        name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '')
      } catch {
        // Malformed percent-encoding: treat as an unknown asset, not a 400.
        res.writeHead(404)
        res.end()
        return
      }
      if (!ART_ALLOWLIST.has(name)) {
        res.writeHead(404)
        res.end()
        return
      }
      try {
        const data = await readFile(join(artDir, name))
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=86400',
        })
        res.end(data)
      } catch (error: unknown) {
        ctx.logger.warn(`agent-teams: artwork read failed for ${name}: ${String(error)}`)
        res.writeHead(404)
        res.end()
      }
      },
    }), 'agent-teams: artwork route')
  }

  registerWebSurface()
  ctx.on('internal/service', (name) => {
    if (WEB_SERVER_KEYS.includes(name as (typeof WEB_SERVER_KEYS)[number])
      || WORKSPACE_KEYS.includes(name as (typeof WORKSPACE_KEYS)[number])) {
      registerWebSurface()
    }
  })
}
