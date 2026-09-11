/**
 * Route preflight: validate a resolved `DispatchSpec` against the host
 * routing and transport-capability surfaces BEFORE any dispatch attempt.
 * Like `roster.ts` and `dispatch.ts`, this module is deliberately pure —
 * the host surfaces arrive injected in `deps` (production wires `ctx.llm`
 * and `ctx.subagents` in `index.ts`; tests inject mocks), so the whole
 * link stays unit-testable against the exact field contracts below.
 *
 * Injected service shapes (mirroring the fork's own call surfaces):
 * - `deps.llm.resolveCallConfig({ provider, model }, signal?)` →
 *   `{ provider, model, reasoningEffort? }` — the exact object-config call
 *   `spawnMember` makes in `members.ts`. It is a LOCAL route-resolvability
 *   check (route exists in the provider registry), NOT a liveness probe:
 *   passing it does NOT guarantee a request succeeds — network/auth failures
 *   surface later through the dispatch settlement error mapping.
 * - `deps.capabilities.getProvider(name)` → provider record or undefined —
 *   the host `ctx.subagents` service, the same support-face source
 *   `spawnMember` reads. Per the host contract, method presence IS the
 *   capability: `continuable` support means `prepareContinuable` exists on
 *   the provider (fork has it, spawn does not); the other knobs map onto the
 *   provider's `capabilities` booleans by name.
 *
 * Behavior contract (each clause is pinned by `test/route.test.ts`):
 * - The capability gate runs FIRST and applies to EVERY policy (including
 *   inherit) — a required knob the transport backend cannot apply fails
 *   loudly with 「角色 X 需要能力 Y，传输后端 Z 不支持」; silent degradation
 *   is never an option.
 * - `inherit`: always ok — nothing to resolve, `resolveCallConfig` is never
 *   called.
 * - `fixed`: exactly one `resolveCallConfig({ provider, model })`; success
 *   → `ok.resolved` (the resolved route), a throw → `ok:false` with the
 *   provider/model and the 「路由解析失败（本地校验，非在线探活）——派单仍
 *   可能因网络/鉴权失败」 wording.
 * - `auto`: candidates are tried in order (order IS priority — no ties, no
 *   concurrent race) and the FIRST that resolves wins. An EMPTY candidate
 *   list is exhaustion. An exhausted chain follows `fallback`:
 *   'error' (default) → `ok:false` with 「auto 链全部不可用」 plus a
 *   truncated per-candidate summary; 'inherit' → `ok:true` whose `notes`
 *   MUST carry 「auto 链全部不可用，已回退主模型」 — the warning is the R5
 *   audit clause and must stay visible to the caller.
 * - `notes` passthrough: on inherit fallback the notes array is non-empty
 *   and reaches the return value verbatim (Task 8 writes it into the tool
 *   result).
 * - Known boundaries: no concurrency aggregation (candidates resolve
 *   sequentially); an unregistered transport provider fails loudly instead
 *   of guessing; a required gate with NO injected `capabilities` service
 *   fails CLOSED — real specs always carry knobs (`roster.ts` always pushes
 *   'persona'), so a missing service means the gate cannot run, which is a
 *   failure, never a silent skip (same asymmetry as a missing `llm`).
 * @module dsh-subagent-roster/route
 */

import type { DispatchSpec } from './roster.ts'

/**
 * The slice of the host `ctx.llm` surface this module touches — narrowed
 * from the injected `unknown` at the single call site.
 */
interface LlmLike {
  resolveCallConfig(config: { provider: string; model: string }, signal?: AbortSignal):
    Promise<{ provider: string; model: string; reasoningEffort?: string }>
}

/** The provider support face: `SubagentCapabilities` narrowed to the knobs a DispatchSpec can require. */
interface ProviderCapabilitiesLike {
  persona?: boolean
  agentOptions?: boolean
  depthLimit?: boolean
  toolFilter?: boolean
}

/** The slice of a host `SubagentProvider` this module reads. */
interface ProviderLike {
  capabilities?: ProviderCapabilitiesLike
  /** Method presence IS the `continuable` capability (host contract). */
  prepareContinuable?: (request: unknown) => Promise<unknown>
}

/** The slice of the host `ctx.subagents` service this module touches. */
interface CapabilitiesLike {
  getProvider(name: string): ProviderLike | undefined
}

/** Services the route preflight needs; production injects the host context. */
export interface RouteDeps {
  /** Host `ctx.llm` (mocked in tests); unused under the inherit policy. */
  llm?: unknown
  /**
   * Host `ctx.subagents` (mocked in tests); provides `getProvider`. A spec
   * that declares knobs and arrives WITHOUT this service fails closed — the
   * gate cannot run against a missing support face.
   */
  capabilities?: unknown
}

/** One route-preflight request, as the dispatch tool layer resolves it. */
export interface RouteArgs {
  /** The roster transport: which subagent provider family creates the child. */
  transport: 'spawn' | 'fork'
  /** The resolved roster spec (see `roster.ts`). */
  spec: DispatchSpec
}

/** Route preflight outcome: a usable route, or a loud, actionable failure. */
export type RouteResult =
  | { ok: true; resolved?: { provider: string; model: string }; notes?: string[] }
  | { ok: false; error: string }

/** Hard cap for the auto-chain failure summary (roster.ts detail convention). */
const SUMMARY_MAX_CHARS = 200

function truncate(text: string): string {
  return text.length > SUMMARY_MAX_CHARS ? text.slice(0, SUMMARY_MAX_CHARS) : text
}

/** Render one route candidate for error/summary surfaces. */
function routeName(candidate: { provider: string; model: string }): string {
  return `provider=${candidate.provider}, model=${candidate.model}`
}

/** The routing intent a spec carries, derived once so control flow stays explicit. */
type RouteIntent =
  | { kind: 'inherit' }
  | { kind: 'fixed'; route: { provider: string; model: string } }
  | { kind: 'auto'; candidates: { provider: string; model: string }[] }

/**
 * Derive the routing intent from a spec, mirroring `roster.ts` emission
 * semantics: `autoCandidates` exists ONLY under modelPolicy=auto; a fixed
 * policy always carries both provider and model in `agentOptions`; anything
 * else is inherit. Only the fixed/auto intent contributes reasoningEffort/
 * maxTokens knobs, which ride `spec.agentOptions` into dispatch untouched —
 * route resolution here covers provider/model only.
 */
function routeIntent(spec: DispatchSpec): RouteIntent {
  if (spec.autoCandidates !== undefined) return { kind: 'auto', candidates: spec.autoCandidates }
  const provider = spec.agentOptions?.provider
  const model = spec.agentOptions?.model
  if (provider !== undefined && model !== undefined) return { kind: 'fixed', route: { provider, model } }
  return { kind: 'inherit' }
}

/**
 * Does the transport provider support one required knob? Same-named knobs
 * read the provider's capability booleans; `continuable` is gated by method
 * presence (`prepareContinuable`), per the host "method presence IS the
 * capability" contract.
 */
function providerSupports(provider: ProviderLike, knob: DispatchSpec['capabilitiesNeeded'][number]): boolean {
  if (knob === 'continuable') return typeof provider.prepareContinuable === 'function'
  return provider.capabilities?.[knob] === true
}

/**
 * Check `spec.capabilitiesNeeded` against the transport provider's support
 * face. Every missing knob is reported — the error names the role, the knob,
 * and the backend, because silent degradation is not an option.
 */
function checkCapabilities(
  capabilities: CapabilitiesLike, transport: 'spawn' | 'fork', spec: DispatchSpec,
): { ok: true } | { ok: false; error: string } {
  const provider = capabilities.getProvider(transport)
  if (provider === undefined) {
    return {
      ok: false,
      error: `角色「${spec.name}」路由预检失败：传输后端 "${transport}" 未注册（getProvider 返回 undefined）`
        + '——检查 subagent provider（如 subagent-spawn/subagent-fork）是否挂载',
    }
  }
  const missing = spec.capabilitiesNeeded.filter(knob => !providerSupports(provider, knob))
  if (missing.length === 0) return { ok: true }
  const reasons = missing.map(knob => `角色「${spec.name}」需要能力 ${knob}，传输后端 ${transport} 不支持`)
  return { ok: false, error: reasons.join('；') }
}

/** Resolve one route candidate through the host llm service. */
async function resolveRoute(
  llm: LlmLike, candidate: { provider: string; model: string },
): Promise<{ provider: string; model: string }> {
  // Local route-resolvability check, NOT a liveness probe: this validates the
  // route exists in the provider registry; a real request can still fail on
  // network/auth, which the dispatch settlement error mapping handles.
  const resolved = await llm.resolveCallConfig({ provider: candidate.provider, model: candidate.model })
  return { provider: resolved.provider, model: resolved.model }
}

/**
 * Preflight the route for one resolved roster spec: capability gate first
 * (no silent degradation), then policy-specific route resolution.
 * @param deps - injected host services (`llm`, `capabilities`).
 * @param args - the transport and the resolved spec.
 * @returns the resolved route (fixed/auto winner), or inherit-fallback notes.
 */
export async function preflightRoute(deps: RouteDeps, args: RouteArgs): Promise<RouteResult> {
  if (args.transport !== 'spawn' && args.transport !== 'fork') {
    throw new Error(`roster route: invalid transport ${JSON.stringify(String(args.transport))} — expected "spawn" or "fork"`)
  }

  const spec = args.spec

  // Gate 1: capability gate, before any route resolution, for EVERY policy —
  // a backend that cannot apply a required knob must fail loudly here. Real
  // specs always carry knobs (roster.ts always pushes 'persona'), so a spec
  // with knobs and NO capabilities service means the gate cannot run: fail
  // closed instead of silently skipping the gate.
  if (deps.capabilities !== undefined) {
    const gate = checkCapabilities(deps.capabilities as CapabilitiesLike, args.transport, spec)
    if (!gate.ok) return gate
  } else if (spec.capabilitiesNeeded.length > 0) {
    return {
      ok: false,
      error: `角色「${spec.name}」能力门控失败：deps.capabilities 未注入，无法验证角色能力需求（fail-closed）——`
        + `该角色声明需要 ${spec.capabilitiesNeeded.join('/')}，生产 wiring 必须提供能力查询面（ctx.subagents）`,
    }
  }

  const intent = routeIntent(spec)

  // inherit: nothing to resolve — the host default route applies.
  if (intent.kind === 'inherit') return { ok: true }

  const llm = deps.llm as LlmLike | undefined
  if (llm === undefined) {
    return {
      ok: false,
      error: `角色「${spec.name}」路由预检失败：需要路由解析但 deps.llm 未注入（fixed/auto 策略必须提供 ctx.llm）`,
    }
  }

  // fixed: exactly one resolution attempt against the configured route.
  if (intent.kind === 'fixed') {
    try {
      return { ok: true, resolved: await resolveRoute(llm, intent.route) }
    } catch (error) {
      return {
        ok: false,
        error: `角色「${spec.name}」路由解析失败（本地校验，非在线探活）——派单仍可能因网络/鉴权失败：`
          + `${routeName(intent.route)}: ${String(error)}`,
      }
    }
  }

  // auto: first candidate that resolves wins; an EMPTY chain is exhaustion.
  const candidates = intent.candidates
  const attempts: string[] = []
  for (const candidate of candidates) {
    try {
      return { ok: true, resolved: await resolveRoute(llm, candidate) }
    } catch (error) {
      attempts.push(`${routeName(candidate)}: ${String(error)}`)
    }
  }

  const summary = truncate(attempts.join('；'))
  if (spec.fallback === 'inherit') {
    // The R5 audit clause: the warning MUST stay visible to the caller —
    // Task 8 writes these notes into the tool result verbatim.
    const notes = [`角色「${spec.name}」：auto 链全部不可用，已回退主模型`]
    if (summary !== '') notes.push(`候选失败摘要: ${summary}`)
    return { ok: true, notes }
  }
  return {
    ok: false,
    error: `角色「${spec.name}」：auto 链全部不可用（候选 ${candidates.length} 个，fallback=error）——${summary}`,
  }
}
