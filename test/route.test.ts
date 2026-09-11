/**
 * Route preflight contract tests (Task 7).
 *
 * These specify `src/route.ts`: the pure link between a resolved
 * `DispatchSpec` and the host routing/capability surfaces, injected via
 * `deps.llm` (the host `ctx.llm`) and `deps.capabilities` (the host
 * `ctx.subagents`, whose `getProvider` exposes the transport provider's
 * support face — the same service `spawnMember` reads in `members.ts`).
 *
 * Mock shapes follow the fork's own call surfaces, NOT flat argument lists:
 * - `llm.resolveCallConfig({ provider, model }, signal?)` →
 *   `{ provider, model, reasoningEffort? }` (object config + optional signal,
 *   exactly as `members.ts` calls it).
 * - `capabilities.getProvider(name)` → provider record or undefined; the
 *   support face is `capabilities.{persona,agentOptions,depthLimit,toolFilter}`
 *   plus `prepareContinuable` (method presence IS the capability — host wording).
 *
 * Behavior matrix (brief contracts 1–5):
 * 1. inherit: always ok — no route to resolve, zero resolveCallConfig calls
 * 2. fixed: one resolveCallConfig; success → ok.resolved; throw → ok:false with
 *    provider/model and 「路由解析失败（本地校验，非在线探活）——派单仍可能因网络/鉴权失败」
 * 3. auto: first candidate that resolves wins; exhausted chain →
 *    fallback 'error' → ok:false with 「auto 链全部不可用」+ per-candidate summary
 *    (truncated); fallback 'inherit' → ok:true with notes carrying
 *    「auto 链全部不可用，已回退主模型」; an EMPTY chain is exhaustion too
 * 4. capability gate (no silent degradation): each spec knob is checked against
 *    the transport provider support face; a missing one fails with
 *    「角色 X 需要能力 Y，传输后端 Z 不支持」; a REQUIRED gate with no
 *    injected capabilities service fails CLOSED (real specs always carry
 *    knobs, so a missing service must never silently skip the gate)
 * 5. notes passthrough: the inherit-fallback warning reaches the returned value
 *    as a non-empty string array (Task 8 writes it into the tool result)
 */
import { describe, expect, it, vi } from 'vitest'
import type { DispatchSpec } from '../src/roster.ts'
import { preflightRoute, type RouteArgs, type RouteDeps } from '../src/route.ts'

/** A resolveCallConfig config bundle as the fork passes it (members.ts). */
type CallConfigLike = { provider: string; model: string }

/** Build a mock ctx.llm whose resolveCallConfig fails for chosen providers. */
function mockLlm(
  failProviders: string[] = [],
  /** Failure message body; overridable to construct over-length summaries. */
  failMessage = 'is not configured',
): { resolveCallConfig: ReturnType<typeof vi.fn> } {
  return {
    resolveCallConfig: vi.fn(async (config: CallConfigLike) => {
      if (failProviders.includes(config.provider)) {
        throw new Error(`provider "${config.provider}" ${failMessage}`)
      }
      return { provider: config.provider, model: config.model }
    }),
  }
}

/** One transport provider record as ctx.subagents.getProvider would return it. */
interface MockProvider {
  capabilities?: Partial<Record<'persona' | 'agentOptions' | 'depthLimit' | 'toolFilter', boolean>>
  prepareContinuable?: () => Promise<unknown>
}

/**
 * A realistic in-process provider: every knob true, continuable present.
 * (Both real 0.1.5-rc.1 in-process backends look like this — see the I1
 * erratum note in the capability-gate describe block.)
 */
const FULL: MockProvider = {
  capabilities: { persona: true, agentOptions: true, depthLimit: true, toolFilter: true },
  prepareContinuable: async () => ({}),
}

/** Build a mock ctx.subagents exposing only getProvider. */
function mockCapabilities(providers: Record<string, MockProvider>): { getProvider: ReturnType<typeof vi.fn> } {
  return { getProvider: vi.fn((name: string) => providers[name]) }
}

/** A DispatchSpec as roster.ts would emit it, with knob overrides. */
function baseSpec(overrides: Partial<DispatchSpec> = {}): DispatchSpec {
  return {
    name: '百晓',
    label: '📚 百晓',
    persona: 'You are 百晓, a scout.',
    maxDepth: 3,
    backgroundMode: 'one-shot',
    fallback: 'error',
    capabilitiesNeeded: ['persona'],
    ...overrides,
  }
}

/** Fixed-policy spec: roster.ts sets agentOptions.provider/model. */
function fixedSpec(overrides: Partial<DispatchSpec> = {}): DispatchSpec {
  return baseSpec({
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    capabilitiesNeeded: ['persona', 'agentOptions'],
    ...overrides,
  })
}

/** Auto-policy spec: roster.ts mirrors the roster autoChain into autoCandidates. */
function autoSpec(overrides: Partial<DispatchSpec> = {}): DispatchSpec {
  return baseSpec({
    autoCandidates: [
      { provider: 'openai', model: 'gpt-5' },
      { provider: 'deepseek', model: 'deepseek-chat' },
    ],
    capabilitiesNeeded: ['persona', 'agentOptions'],
    ...overrides,
  })
}

/** Default args: spawn transport; route.ts only reads transport + spec. */
function baseArgs(spec: DispatchSpec, overrides: Partial<RouteArgs> = {}): RouteArgs {
  return { transport: 'spawn', spec, ...overrides }
}

/** Both required clauses of the fixed-failure wording (contract 2). */
const LOCAL_CHECK_WORDED = /路由解析失败（本地校验，非在线探活）——派单仍可能因网络\/鉴权失败/
/** The exact inherit-fallback warning text (contracts 3 & 5, the R5 clause). */
const INHERIT_FALLBACK_WORDED = 'auto 链全部不可用，已回退主模型'

describe('preflightRoute — inherit policy (contract 1)', () => {
  it('is always ok with no route to resolve and never touches resolveCallConfig', async () => {
    const llm = mockLlm()
    // A registered full-support provider: the gate passes, routing is a no-op.
    const result = await preflightRoute(
      { llm, capabilities: mockCapabilities({ spawn: FULL }) },
      baseArgs(baseSpec()),
    )
    expect(result).toEqual({ ok: true })
    expect(llm.resolveCallConfig).not.toHaveBeenCalled()
  })

  it('is ok with no llm injected and no knob to gate (empty capabilitiesNeeded)', async () => {
    const result = await preflightRoute(
      {},
      baseArgs(baseSpec({ capabilitiesNeeded: [] })),
    )
    expect(result).toEqual({ ok: true })
  })

  it('is ok with no llm at all when the gate passes on an injected capabilities service', async () => {
    // inherit has nothing to resolve; the gate still runs (real specs always
    // carry knobs — roster.ts always pushes 'persona').
    const result = await preflightRoute(
      { capabilities: mockCapabilities({ spawn: FULL }) },
      baseArgs(baseSpec()),
    )
    expect(result).toEqual({ ok: true })
  })
})

describe('preflightRoute — fixed policy (contract 2)', () => {
  it('calls resolveCallConfig once with {provider, model} and returns the resolved route', async () => {
    const llm = mockLlm()
    const result = await preflightRoute({ llm, capabilities: mockCapabilities({ spawn: FULL }) }, baseArgs(fixedSpec()))
    expect(llm.resolveCallConfig).toHaveBeenCalledTimes(1)
    expect(llm.resolveCallConfig).toHaveBeenCalledWith({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(result).toEqual({ ok: true, resolved: { provider: 'deepseek', model: 'deepseek-chat' } })
  })

  it('fails with provider/model and the local-check wording when resolution throws', async () => {
    const llm = mockLlm(['deepseek'])
    const result = await preflightRoute({ llm, capabilities: mockCapabilities({ spawn: FULL }) }, baseArgs(fixedSpec()))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('deepseek-chat')
    expect(result.error).toMatch(LOCAL_CHECK_WORDED)
  })

  it('surfaces the thrown reason inside the fixed failure error', async () => {
    const llm = mockLlm(['deepseek'])
    const result = await preflightRoute({ llm, capabilities: mockCapabilities({ spawn: FULL }) }, baseArgs(fixedSpec()))
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('is not configured')
  })
})

describe('preflightRoute — auto chain (contract 3)', () => {
  it('selects the FIRST candidate that resolves and stops calling the chain', async () => {
    const llm = mockLlm()
    const result = await preflightRoute({ llm, capabilities: mockCapabilities({ spawn: FULL }) }, baseArgs(autoSpec()))
    expect(llm.resolveCallConfig).toHaveBeenCalledTimes(1)
    expect(llm.resolveCallConfig).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5' })
    expect(result).toEqual({ ok: true, resolved: { provider: 'openai', model: 'gpt-5' } })
  })

  it('falls through a failing candidate to the next one in order', async () => {
    const llm = mockLlm(['openai'])
    const result = await preflightRoute({ llm, capabilities: mockCapabilities({ spawn: FULL }) }, baseArgs(autoSpec()))
    expect(llm.resolveCallConfig).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: true, resolved: { provider: 'deepseek', model: 'deepseek-chat' } })
  })

  it("fails with 「auto 链全部不可用」 plus per-candidate summary when fallback='error'", async () => {
    const llm = mockLlm(['openai', 'deepseek'])
    const result = await preflightRoute(
      { llm, capabilities: mockCapabilities({ spawn: FULL }) },
      baseArgs(autoSpec({ fallback: 'error' })),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('auto 链全部不可用')
    // Per-candidate summary: every candidate's provider and failure reason survive.
    expect(result.error).toContain('openai')
    expect(result.error).toContain('deepseek')
    expect(result.error).toContain('is not configured')
  })

  it("succeeds with the R5 warning in notes when fallback='inherit'", async () => {
    const llm = mockLlm(['openai', 'deepseek'])
    const result = await preflightRoute(
      { llm, capabilities: mockCapabilities({ spawn: FULL }) },
      baseArgs(autoSpec({ fallback: 'inherit' })),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    // Inherit means the host default route applies — no resolved route.
    expect(result.resolved).toBeUndefined()
    expect(result.notes).toBeDefined()
    expect(result.notes!.length).toBeGreaterThan(0)
    expect(result.notes!.some(note => note.includes(INHERIT_FALLBACK_WORDED))).toBe(true)
  })

  it('treats an EMPTY autoCandidates chain as exhaustion (fallback error path, zero calls)', async () => {
    const llm = mockLlm()
    const result = await preflightRoute(
      { llm, capabilities: mockCapabilities({ spawn: FULL }) },
      baseArgs(autoSpec({ autoCandidates: [], fallback: 'error' })),
    )
    expect(llm.resolveCallConfig).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('auto 链全部不可用')
  })

  it('treats an EMPTY autoCandidates chain as exhaustion (fallback inherit path)', async () => {
    const llm = mockLlm()
    const result = await preflightRoute(
      { llm, capabilities: mockCapabilities({ spawn: FULL }) },
      baseArgs(autoSpec({ autoCandidates: [], fallback: 'inherit' })),
    )
    expect(llm.resolveCallConfig).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.notes!.some(note => note.includes(INHERIT_FALLBACK_WORDED))).toBe(true)
  })

  it('truncates the per-candidate failure summary at 200 chars (roster detail convention)', async () => {
    const llm = mockLlm(['openai', 'deepseek'], 'x'.repeat(300))
    const result = await preflightRoute(
      { llm, capabilities: mockCapabilities({ spawn: FULL }) },
      baseArgs(autoSpec({ fallback: 'error' })),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('auto 链全部不可用')
    // The summary segment after the 「——」 separator is capped; the headline prefix stays intact.
    const summary = result.error.split('——')[1] ?? ''
    expect(summary.length).toBeGreaterThan(0)
    expect(summary.length).toBeLessThanOrEqual(200)
  })
})

describe('preflightRoute — capability gate (contract 4, no silent degradation)', () => {
  /** A realistic in-process fork provider: all knobs true, continuable present. */
  const FORK: MockProvider = {
    capabilities: { persona: true, agentOptions: true, depthLimit: true, toolFilter: true },
    prepareContinuable: async () => ({}),
  }
  // Erratum I1: the REAL spawn-in-process AND fork-in-process providers of
  // 0.1.5-rc.1 both declare `prepareContinuable()`. The record below is a
  // HYPOTHETICAL backend (all knobs true, no continuable method) exercising
  // the gate's no-continuable branch — not a faithful model of the currently
  // installed backends.
  const NO_CONTINUABLE: MockProvider = {
    capabilities: { persona: true, agentOptions: true, depthLimit: true, toolFilter: true },
  }

  it("fails listing 「角色 X 需要能力 Y，传输后端 Z 不支持」 when the transport cannot apply 'continuable'", async () => {
    const llm = mockLlm()
    const spec = baseSpec({
      backgroundMode: 'continuable',
      capabilitiesNeeded: ['persona', 'continuable'],
    })
    const result = await preflightRoute(
      { llm, capabilities: mockCapabilities({ spawn: NO_CONTINUABLE }) },
      baseArgs(spec, { transport: 'spawn' }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('百晓')
    expect(result.error).toContain('continuable')
    expect(result.error).toContain('spawn')
    expect(result.error).toMatch(/角色.+需要能力 continuable，传输后端 spawn 不支持/)
  })

  it('lists EVERY missing knob, not just the first', async () => {
    const llm = mockLlm()
    const crippled: MockProvider = { capabilities: { persona: false, toolFilter: false } }
    const spec = baseSpec({
      toolFilter: { deny: ['agent_teams_delete'] },
      capabilitiesNeeded: ['persona', 'toolFilter'],
    })
    const result = await preflightRoute(
      { llm, capabilities: mockCapabilities({ spawn: crippled }) },
      baseArgs(spec, { transport: 'spawn' }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/需要能力 persona/)
    expect(result.error).toMatch(/需要能力 toolFilter/)
  })

  it('passes a continuable role on the fork transport (prepareContinuable present)', async () => {
    const llm = mockLlm()
    const spec = baseSpec({
      backgroundMode: 'continuable',
      capabilitiesNeeded: ['persona', 'continuable'],
    })
    const result = await preflightRoute(
      { llm, capabilities: mockCapabilities({ fork: FORK }) },
      baseArgs(spec, { transport: 'fork' }),
    )
    expect(result).toEqual({ ok: true })
  })

  it('maps every same-named knob onto provider.capabilities and fails on a false one', async () => {
    const llm = mockLlm()
    const noDepth: MockProvider = { capabilities: { persona: true, agentOptions: true, depthLimit: false, toolFilter: true } }
    const spec = baseSpec({ maxDepth: 5, capabilitiesNeeded: ['persona', 'agentOptions', 'depthLimit'] })
    const result = await preflightRoute(
      { llm, capabilities: mockCapabilities({ spawn: noDepth }) },
      baseArgs(spec, { transport: 'spawn' }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/需要能力 depthLimit/)
  })

  it('fails when the transport provider is not registered at all', async () => {
    const llm = mockLlm()
    const result = await preflightRoute(
      { llm, capabilities: mockCapabilities({}) },
      baseArgs(baseSpec(), { transport: 'fork' }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('fork')
  })

  it('runs the gate BEFORE route resolution — a fixed spec with a failing gate never reaches resolveCallConfig', async () => {
    // A fixed spec ROUTE WOULD resolve (agentOptions carries provider/model);
    // the gate must reject it first, otherwise this assertion fails.
    const llm = mockLlm()
    const gateBlocksFixed: MockProvider = { capabilities: { persona: true, agentOptions: false } }
    const result = await preflightRoute(
      { llm, capabilities: mockCapabilities({ spawn: gateBlocksFixed }) },
      baseArgs(fixedSpec(), { transport: 'spawn' }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/需要能力 agentOptions/)
    expect(llm.resolveCallConfig).not.toHaveBeenCalled()
  })

  it('fails CLOSED when a gate is required but no capabilities service is injected (no silent gate skip)', async () => {
    // Real specs always carry knobs (roster.ts always pushes 'persona'), so a
    // missing capabilities service means the gate CANNOT run — that is a
    // failure, not a pass (same fail-closed asymmetry as a missing llm).
    const llm = mockLlm()
    const result = await preflightRoute({ llm }, baseArgs(baseSpec()))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/能力(查询面|门控)/)
    expect(llm.resolveCallConfig).not.toHaveBeenCalled()
  })
})

describe('preflightRoute — notes passthrough (contract 5)', () => {
  it('delivers a non-empty string-array notes field to the caller on inherit fallback', async () => {
    const llm = mockLlm(['openai', 'deepseek'])
    const result = await preflightRoute(
      { llm, capabilities: mockCapabilities({ spawn: FULL }) },
      baseArgs(autoSpec({ fallback: 'inherit' })),
    )
    if (!result.ok) throw new Error('expected success')
    expect(Array.isArray(result.notes)).toBe(true)
    expect(result.notes!.length).toBeGreaterThan(0)
    for (const note of result.notes!) expect(typeof note).toBe('string')
    // The R5 audit clause rides the first note verbatim.
    expect(result.notes![0]).toContain(INHERIT_FALLBACK_WORDED)
  })

  it('does not emit notes on a plain successful route', async () => {
    const llm = mockLlm()
    const result = await preflightRoute({ llm, capabilities: mockCapabilities({ spawn: FULL }) }, baseArgs(autoSpec()))
    if (!result.ok) throw new Error('expected success')
    expect(result.notes).toBeUndefined()
  })
})

describe('preflightRoute — seam defenses', () => {
  it('throws on a transport other than spawn/fork before touching any service', async () => {
    const llm = mockLlm()
    const capabilities = mockCapabilities({})
    await expect(preflightRoute(
      { llm, capabilities },
      baseArgs(baseSpec(), { transport: 'teleport' as unknown as 'spawn' }),
    )).rejects.toThrow(/spawn.*fork/)
    expect(llm.resolveCallConfig).not.toHaveBeenCalled()
    expect(capabilities.getProvider).not.toHaveBeenCalled()
  })
})
