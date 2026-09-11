/**
 * Roster model-facing tools contract tests (Task 8, parts B/C).
 *
 * These specify the two tools registered by `registerRosterTools` in
 * `src/tools.ts`: `roster_list` (read-only directory) and `roster_agent`
 * (the full dispatch link: schema → readRoster → resolveAgent →
 * preflightRoute → dispatch).
 *
 * Error convention: every mapped failure is surfaced as a thrown, messageed
 * Error from `execute` — the DSH tool registry materializes thrown tool
 * errors as `isError` results whose text carries the message (the exact
 * convention all 11 existing agent_teams_* tools use). Only the parent
 * defense (missing `exec.agent`) throws without further mapping, mirroring
 * the dispatch modules' own parent line of defense.
 *
 * The roster is driven through the REAL `getRoster()` read path: tests point
 * the settings source via `registerRosterSettings` + a mock settings provider
 * (same mechanism `settings.test.ts` uses), then corrupt/readonly/empty
 * sources exercise the three-state contract end to end.
 *
 * Behavior matrix (brief B/C):
 * B  roster_list three states: enabled directory (disabled excluded) /
 *    empty → maintenance note / corrupted-or-readonly → isError summary.
 * C  roster_agent mock full chain: continuable success (startContinuable
 *    payload + signal forwarding) / foreground one-shot ok / not-found with
 *    available list / disabled / preflight failure / one-shot background
 *    (jobs.start registration) / fallback notes in the result (R5) / parent
 *    defense / run_in_background silently ignored for continuable roles /
 *    NO description parameter on the tool schema (v2 decision).
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { registerRosterSettings } from '../src/settings.ts'
import { registerRosterTools, renderRosterList, renderRosterAgentResult } from '../src/tools.ts'

/** The hooks slice `registerRosterSettings` hands to the settings provider. */
interface RosterSettingsInstall {
  setSource(current: () => never): void
}

/* ------------------------------------------------------------------ *
 * Harness: point the real getRoster() source through a mock provider. *
 * ------------------------------------------------------------------ */

/** Install a raw roster source as the current settings truth. */
function installRoster(source: unknown): void {
  const provider = {
    installSection: (
      _owner: unknown, _ns: unknown, _schema: unknown, _entry: unknown,
      hooks: RosterSettingsInstall,
    ): unknown => {
      hooks.setSource(() => source as never)
      return undefined
    },
  }
  const mockCtx = {
    inject: (_keys: string[], cb: (ctx: unknown) => void) => cb({ settings: provider }),
  }
  registerRosterSettings(mockCtx as unknown as Context, {} as never)
}

/** A raw roster source with the standard test cast: two enabled, one disabled. */
const ROSTER_CAST = {
  schemaVersion: 1,
  transport: 'spawn',
  agents: [
    { name: '百晓', icon: '📚', description: '调研', persona: 'p1' },
    { name: '风清', description: '文案', persona: 'p2', backgroundMode: 'one-shot' },
    { name: '休眠者', description: '停用', persona: 'p3', enabled: false },
  ],
  autoChain: [],
}

/** A transport provider record as ctx.subagents.getProvider returns it. */
const FULL_PROVIDER = {
  capabilities: { persona: true, agentOptions: true, depthLimit: true, toolFilter: true },
  prepareContinuable: async () => ({}),
}

/** Mock run for the one-shot foreground path (settles completed). */
function completedRun(text = '调研结果如下') {
  return {
    id: 'run-1',
    result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
    dispose: vi.fn(async () => {}),
  }
}

/** A fully-wired mock host context; each surface is overridable per test. */
function mockCtx(overrides: {
  llm?: unknown
  subagents?: unknown
  jobs?: unknown
} = {}) {
  const subagents = overrides.subagents ?? {
    getProvider: vi.fn(() => FULL_PROVIDER),
    startContinuable: vi.fn(async () => ({ childId: 'child-1', messageId: 'msg-1' })),
    start: vi.fn(async () => completedRun()),
  }
  const ctx = {
    tools: { register: vi.fn() },
    llm: overrides.llm,
    subagents,
    jobs: overrides.jobs,
    // Cordis service accessor: the tool reads optional ctx.jobs through it.
    get: (key: string) => (ctx as Record<string, unknown>)[key],
  }
  return ctx as unknown as Context & { tools: { register: ReturnType<typeof vi.fn> } }
}

/** Registered tool definitions keyed by name. */
function registeredTools(ctx: ReturnType<typeof mockCtx>): Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown>; parameters: Record<string, unknown>; description: string }> {
  const map = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown>; parameters: Record<string, unknown>; description: string }>()
  for (const call of ctx.tools.register.mock.calls) {
    const def = call[0] as { name: string; execute: never; parameters: never; description: string }
    map.set(def.name, def as never)
  }
  return map
}

/** Install a roster, register the tools, and return the two definitions + ctx. */
function setup(rosterSource: unknown, overrides: Parameters<typeof mockCtx>[0] = {}) {
  installRoster(rosterSource)
  const ctx = mockCtx(overrides)
  registerRosterTools(ctx)
  const tools = registeredTools(ctx)
  const list = tools.get('roster_list')
  const dispatch = tools.get('roster_agent')
  if (list === undefined || dispatch === undefined) {
    throw new Error(`expected roster_list and roster_agent registered, got [${[...tools.keys()].join(', ')}]`)
  }
  return { ctx, list, dispatch, subagents: ctx.subagents as never, jobs: ctx.jobs as never }
}

/** A ToolRunContext for a parent agent. */
function execOf(agent?: unknown): ToolRunContext {
  return {
    agent,
    signal: new AbortController().signal,
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('token'),
    name: 'roster_agent',
    arguments: {},
    deferContext: () => {},
    concludeTurn: () => {},
  } as unknown as ToolRunContext
}

const PARENT = { id: 'parent-1' }

/* ------------------------------------------------------------------ *
 * B — roster_list                                                     *
 * ------------------------------------------------------------------ */

describe('roster_list — three states', () => {
  it('returns the enabled directory with name/icon/description/modelPolicy/backgroundMode; disabled excluded', async () => {
    const { list } = setup(ROSTER_CAST)
    const value = await list.execute({}, execOf(PARENT)) as Array<Record<string, unknown>>
    expect(value).toHaveLength(2) // 休眠者 excluded
    expect(value[0]).toMatchObject({ name: '百晓', icon: '📚', description: '调研', modelPolicy: 'inherit', backgroundMode: 'continuable' })
    expect(value[1]).toMatchObject({ name: '风清', description: '文案', modelPolicy: 'inherit', backgroundMode: 'one-shot' })
  })

  it('empty roster: empty directory and the render carries the maintenance note', async () => {
    const { list } = setup(undefined)
    const value = await list.execute({}, execOf(PARENT)) as unknown[]
    expect(value).toEqual([])
    expect(renderRosterList(value)).toContain('花名册为空，请到设置→插件→子智能体花名册维护')
  })

  it('corrupted roster: isError summary naming the offending field', async () => {
    const { list } = setup({ schemaVersion: 1, agents: [{ name: '' }] })
    await expect(list.execute({}, execOf(PARENT))).rejects.toThrow(/agents\[0\]\.name/)
  })

  it('readonly roster (newer schema): isError summary', async () => {
    const { list } = setup({ schemaVersion: 99 })
    await expect(list.execute({}, execOf(PARENT))).rejects.toThrow(/read-only/)
  })
})

/* ------------------------------------------------------------------ *
 * C — roster_agent: schema surface                                    *
 * ------------------------------------------------------------------ */

describe('roster_agent — parameter schema (v2 decision)', () => {
  it('exposes exactly agent/prompt/run_in_background — NO description parameter', () => {
    const { dispatch } = setup(ROSTER_CAST)
    // The registry compiles the spec: the declared keys live under .properties.
    const compiled = dispatch.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(compiled.properties).sort()).toEqual(['agent', 'prompt', 'run_in_background'])
    expect((compiled.required ?? []).sort()).toEqual(['agent', 'prompt'])
  })

  it('the description states the division of labor', () => {
    const { dispatch } = setup(ROSTER_CAST)
    expect(dispatch.description).toContain('具名角色派单')
    expect(dispatch.description).toContain('roster_list')
  })
})

/* ------------------------------------------------------------------ *
 * C — roster_agent: the full dispatch chain                           *
 * ------------------------------------------------------------------ */

describe('roster_agent — continuable dispatch', () => {
  it('starts a durable child: startContinuable payload, signal forwarding, and the wake-up result text', async () => {
    const { dispatch, subagents } = setup(ROSTER_CAST)
    const exec = execOf(PARENT)
    const value = await dispatch.execute({ agent: '百晓', prompt: '查一下 dsh 0.1.5 的变化' }, exec) as Record<string, unknown>
    const startContinuable = (subagents as { startContinuable: ReturnType<typeof vi.fn> }).startContinuable
    expect(startContinuable).toHaveBeenCalledTimes(1)
    const call = startContinuable.mock.calls[0]![0] as Record<string, never>
    expect(call.provider).toBe('spawn') // roster transport, verbatim
    expect(call.label).toBe('📚 百晓') // label = icon + name
    expect(call.request.parent).toBe(PARENT)
    expect(call.request.persona).toBe('p1')
    expect(call.request.prompt).toEqual([{ type: 'text', text: '查一下 dsh 0.1.5 的变化' }])
    expect(call.signal).toBe(exec.signal) // caller cancellation forwarded
    expect(value).toMatchObject({ dispatched: 'continuable', agent: '百晓', child_id: 'child-1', message_id: 'msg-1' })
    const rendered = renderRosterAgentResult(value)
    expect(rendered).toContain('百晓')
    expect(rendered).toContain('childId child-1')
    expect(rendered).toContain('send_message')
  })

  it('run_in_background is silently ignored for continuable roles (the role is the contract)', async () => {
    const jobs = { start: vi.fn(() => 'subagent-9') }
    const { dispatch, subagents } = setup(ROSTER_CAST, { jobs })
    const value = await dispatch.execute({ agent: '百晓', prompt: 'p', run_in_background: true }, execOf(PARENT)) as Record<string, unknown>
    expect((subagents as { startContinuable: ReturnType<typeof vi.fn> }).startContinuable).toHaveBeenCalledTimes(1)
    expect(jobs.start).not.toHaveBeenCalled()
    expect(value.dispatched).toBe('continuable')
  })
})

describe('roster_agent — one-shot foreground', () => {
  it('ok: returns the child text, disposes the run, and uses neither continuable nor jobs paths', async () => {
    const jobs = { start: vi.fn(() => 'subagent-9') }
    const { dispatch, subagents } = setup(ROSTER_CAST, { jobs })
    const value = await dispatch.execute({ agent: '风清', prompt: '润色这段' }, execOf(PARENT)) as Record<string, unknown>
    const start = (subagents as { start: ReturnType<typeof vi.fn> }).start
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]![0].label).toBe('风清') // no icon → bare name label
    const run = await start.mock.results[0]!.value as unknown as { dispose: ReturnType<typeof vi.fn> }
    expect(run.dispose).toHaveBeenCalledTimes(1)
    expect(jobs.start).not.toHaveBeenCalled()
    expect(value).toMatchObject({ dispatched: 'one-shot-foreground', agent: '风清', text: '调研结果如下' })
    expect(renderRosterAgentResult(value)).toContain('调研结果如下')
  })

  it('failed run (non-completed stop reason): isError carrying the headline', async () => {
    const { dispatch, subagents } = setup(ROSTER_CAST)
    const start = (subagents as { start: ReturnType<typeof vi.fn> }).start
    start.mockImplementationOnce(async () => ({
      id: 'run-2',
      result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'boom' }),
      dispose: vi.fn(async () => {}),
    }))
    await expect(dispatch.execute({ agent: '风清', prompt: 'p' }, execOf(PARENT))).rejects.toThrow(/subagent run failed/)
  })
})

describe('roster_agent — resolution failures (model self-correction)', () => {
  it('not-found: isError naming the role AND the available enabled list', async () => {
    const { dispatch } = setup(ROSTER_CAST)
    const error = await dispatch.execute({ agent: '不存在', prompt: 'p' }, execOf(PARENT)).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('不存在')
    expect(error.message).toContain('百晓')
    expect(error.message).toContain('风清')
    expect(error.message).not.toContain('休眠者') // disabled names never suggested
  })

  it('disabled: isError「角色 X 已停用」', async () => {
    const { dispatch } = setup(ROSTER_CAST)
    await expect(dispatch.execute({ agent: '休眠者', prompt: 'p' }, execOf(PARENT))).rejects.toThrow(/已停用/)
  })
})

describe('roster_agent — route preflight', () => {
  it('preflight failure: isError with the gate error, no dispatch attempted', async () => {
    const subagents = { getProvider: vi.fn(() => undefined) }
    const { dispatch } = setup(ROSTER_CAST, { subagents })
    await expect(dispatch.execute({ agent: '百晓', prompt: 'p' }, execOf(PARENT)))
      .rejects.toThrow(/未注册/)
    expect((subagents as { getProvider: ReturnType<typeof vi.fn> }).getProvider).toHaveBeenCalledWith('spawn')
  })
})

describe('roster_agent — one-shot background', () => {
  it('registers a jobs task (kind subagent, owner = parent) and returns the jobId with usage text', async () => {
    const jobs = { start: vi.fn(() => 'subagent-7') }
    const { dispatch } = setup(ROSTER_CAST, { jobs })
    const value = await dispatch.execute({ agent: '风清', prompt: 'p', run_in_background: true }, execOf(PARENT)) as Record<string, unknown>
    expect(jobs.start).toHaveBeenCalledTimes(1)
    const reg = jobs.start.mock.calls[0]![0] as Record<string, unknown>
    expect(reg.kind).toBe('subagent')
    expect(reg.owner).toBe(PARENT)
    expect(reg.label).toBe('风清')
    expect(value).toMatchObject({ dispatched: 'one-shot-background', agent: '风清', job_id: 'subagent-7' })
    const rendered = renderRosterAgentResult(value)
    expect(rendered).toContain('jobId subagent-7')
    expect(rendered).toContain('job_output')
  })

  it('missing jobs service: mapped isError, not an unwrapped crash', async () => {
    const { dispatch } = setup(ROSTER_CAST, { jobs: undefined })
    await expect(dispatch.execute({ agent: '风清', prompt: 'p', run_in_background: true }, execOf(PARENT)))
      .rejects.toThrow(/jobs/)
  })
})

describe('roster_agent — fallback notes reach the result (R5)', () => {
  it('auto chain exhausted with fallback=inherit: ok:true and the warning rides the foreground result tail', async () => {
    const source = {
      schemaVersion: 1,
      transport: 'spawn',
      agents: [{ name: '自动者', description: '自动路由', persona: 'p4', modelPolicy: 'auto', fallback: 'inherit', backgroundMode: 'one-shot' }],
      autoChain: [{ provider: 'bad-a', model: 'm1' }, { provider: 'bad-b', model: 'm2' }],
    }
    const llm = {
      resolveCallConfig: vi.fn(async (config: { provider: string }) => {
        throw new Error(`provider "${config.provider}" is not configured`)
      }),
    }
    const { dispatch } = setup(source, { llm })
    const value = await dispatch.execute({ agent: '自动者', prompt: 'p' }, execOf(PARENT)) as Record<string, unknown>
    expect(value.dispatched).toBe('one-shot-foreground')
    const notes = value.notes as string[]
    expect(Array.isArray(notes)).toBe(true)
    expect(notes.length).toBeGreaterThan(0)
    expect(notes[0]).toContain('已回退主模型')
    // R5: the notes must be visible in the rendered tool result, not just the value.
    const rendered = renderRosterAgentResult(value)
    expect(rendered).toContain('已回退主模型')
  })
})

describe('roster_agent — parent defense', () => {
  it('missing exec.agent: throws (the parent line of defense) before touching the roster or dispatch', async () => {
    const { dispatch, subagents } = setup(ROSTER_CAST)
    await expect(dispatch.execute({ agent: '百晓', prompt: 'p' }, execOf(undefined))).rejects.toThrow(/agent/)
    expect((subagents as { startContinuable: ReturnType<typeof vi.fn> }).startContinuable).not.toHaveBeenCalled()
  })
})
