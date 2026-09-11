/**
 * Roster lookup and dispatch-spec mapping.
 *
 * Like `schema.ts` and `roster-read.ts`, this module is deliberately pure —
 * zero host imports; only types from the two sibling modules. It turns a
 * roster entry into the `DispatchSpec` every downstream dispatch consumer
 * (spawn/fork task, command surface, model precheck) builds on: one spec,
 * one contract, no per-consumer re-derivation of the roster's semantics.
 *
 * Behavior contract (each clause is pinned by `test/roster.test.ts`):
 * - Lookup is by exact agent name against the roster entries.
 * - `not-found` and `disabled` are distinct failure codes, and both carry
 *   `available`: the CURRENT enabled names (disabled names never appear),
 *   truncated at 20 entries so error surfaces stay bounded.
 * - Model policy → `agentOptions`:
 *   - `inherit`: no provider/model (the host default route applies);
 *     `reasoningEffort`/`maxTokens` ride along when the role configured them.
 *   - `fixed`: provider+model as configured.
 *   - `auto`: NO routing here — `autoCandidates` mirrors the roster
 *     `autoChain` in order and the actual route is decided by the model
 *     precheck AFTER this layer; `agentOptions` still exists (minus routing).
 * - `label` is `${icon} ${name}`; an absent or empty icon degrades to the
 *   bare name.
 * - `capabilitiesNeeded` tells dispatchers which knobs to apply:
 *   `persona` always; `agentOptions` for fixed/auto policies or an inherit
 *   role with reasoningEffort/maxTokens; `toolFilter` when a filter is set;
 *   `depthLimit` when maxDepth ≠ 3; `continuable` when backgroundMode is
 *   durable. Emitted in that canonical order.
 * - `resolveFromRead` is the typed front door for `readRoster` results: a
 *   healthy roster resolves exactly like `resolveAgent`; readonly/corrupted
 *   rosters fail CLOSED with `roster-unavailable` (a ≤ 200-char reason
 *   summary) — a broken roster must never silently resolve against an
 *   empty default roster.
 */

import type { RosterAgent, RosterAutoChainRoute, RosterConfig, ToolFilter } from './schema.ts'
import type { RosterRead } from './roster-read.ts'

/** Everything a dispatch consumer needs to create one roster member. */
export interface DispatchSpec {
  /** Roster agent name, verbatim. */
  name: string
  /** `${icon} ${name}`; the bare name when the icon is absent or empty. */
  label: string
  /** System-prompt persona, verbatim. */
  persona: string
  /** Model/effort options derived from the policy; absent when nothing applies. */
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number }
  /** Tool gate copied from the role; absent when unset. */
  toolFilter?: { deny: string[] } | { allow: string[] }
  /** Delegation depth cap, verbatim (default 3). */
  maxDepth: number
  /** Durable vs one-shot member execution, verbatim. */
  backgroundMode: 'continuable' | 'one-shot'
  /** Auto-chain exhaustion strategy, verbatim. */
  fallback: 'error' | 'inherit'
  /** The roster autoChain in order; only present for modelPolicy=auto. */
  autoCandidates?: { provider: string; model: string }[]
  /** Which knobs the dispatcher must apply, in canonical order. */
  capabilitiesNeeded: ('persona' | 'agentOptions' | 'toolFilter' | 'depthLimit' | 'continuable')[]
}

/** Resolve outcome: a usable spec, an unavailable roster, or a failed lookup. */
export type ResolveResult =
  | { ok: true; spec: DispatchSpec }
  | { ok: false; code: 'roster-unavailable'; detail: string }
  | { ok: false; code: 'not-found' | 'disabled'; available: string[] }

/** Bound on the `available` name list carried by lookup failures. */
const MAX_AVAILABLE = 20
/** Hard cap for the `roster-unavailable` detail string. */
const DETAIL_MAX_CHARS = 200
/** The documented default depth — the one value that needs no depthLimit capability. */
const DEFAULT_MAX_DEPTH = 3

function truncate(text: string): string {
  return text.length > DETAIL_MAX_CHARS ? text.slice(0, DETAIL_MAX_CHARS) : text
}

/** True when the role carries a tool gate with at least one tool name. */
function hasActiveToolFilter(filter: ToolFilter | null | undefined): filter is ToolFilter {
  if (filter === null || filter === undefined) return false
  const list = 'deny' in filter ? filter.deny : filter.allow
  return Array.isArray(list) && list.length > 0
}

/** Map a defaults-filled roster entry onto its DispatchSpec. */
function toDispatchSpec(agent: RosterAgent, autoChain: readonly RosterAutoChainRoute[]): DispatchSpec {
  const capabilities: DispatchSpec['capabilitiesNeeded'] = ['persona']

  // Optional execution knobs that ride along under any policy.
  const extras: { reasoningEffort?: string; maxTokens?: number } = {}
  if (agent.reasoningEffort !== undefined) extras.reasoningEffort = agent.reasoningEffort
  if (typeof agent.maxTokens === 'number') extras.maxTokens = agent.maxTokens
  const hasExtras = extras.reasoningEffort !== undefined || extras.maxTokens !== undefined

  let agentOptions: DispatchSpec['agentOptions']
  if (agent.modelPolicy === 'fixed') {
    agentOptions = { provider: agent.provider, model: agent.model, ...extras }
    capabilities.push('agentOptions')
  } else if (agent.modelPolicy === 'auto') {
    // Routing is decided by the post-resolve precheck, not here.
    agentOptions = { ...extras }
    capabilities.push('agentOptions')
  } else if (hasExtras) {
    agentOptions = { ...extras }
    capabilities.push('agentOptions')
  }

  let toolFilter: DispatchSpec['toolFilter']
  const filter = agent.toolFilter
  if (hasActiveToolFilter(filter)) {
    toolFilter = 'deny' in filter ? { deny: [...filter.deny] } : { allow: [...filter.allow] }
    capabilities.push('toolFilter')
  }

  if (agent.maxDepth !== DEFAULT_MAX_DEPTH) capabilities.push('depthLimit')
  if (agent.backgroundMode === 'continuable') capabilities.push('continuable')

  const spec: DispatchSpec = {
    name: agent.name,
    label: agent.icon ? `${agent.icon} ${agent.name}` : agent.name,
    persona: agent.persona,
    maxDepth: agent.maxDepth,
    backgroundMode: agent.backgroundMode,
    fallback: agent.fallback,
    capabilitiesNeeded: capabilities,
  }
  if (agentOptions !== undefined) spec.agentOptions = agentOptions
  if (toolFilter !== undefined) spec.toolFilter = toolFilter
  if (agent.modelPolicy === 'auto') {
    spec.autoCandidates = autoChain.map(route => ({ provider: route.provider, model: route.model }))
  }
  return spec
}

/** Enabled names in roster order, capped at `MAX_AVAILABLE`. */
function enabledNames(roster: RosterConfig): string[] {
  return roster.agents.filter(agent => agent.enabled).map(agent => agent.name).slice(0, MAX_AVAILABLE)
}

/**
 * Resolve `name` against an already-validated roster config. Unknown names
 * fail with `not-found`, disabled entries with `disabled`; both carry the
 * truncated enabled-name list so callers can suggest alternatives.
 */
export function resolveAgent(roster: RosterConfig, name: string): ResolveResult {
  const available = enabledNames(roster)
  const target = roster.agents.find(agent => agent.name === name)
  if (target === undefined) return { ok: false, code: 'not-found', available }
  if (!target.enabled) return { ok: false, code: 'disabled', available }
  return { ok: true, spec: toDispatchSpec(target, roster.autoChain) }
}

/**
 * Resolve `name` against a `readRoster` result. Healthy reads delegate to
 * `resolveAgent`; readonly or corrupted rosters fail closed with
 * `roster-unavailable` and a truncated reason summary — never a silent
 * fallback to an empty default roster.
 */
export function resolveFromRead(read: RosterRead, name: string): ResolveResult {
  if (read.ok) return resolveAgent(read.roster, name)
  if ('readonly' in read) {
    return {
      ok: false,
      code: 'roster-unavailable',
      detail: truncate(
        'roster is unavailable: stored schemaVersion is newer than this build — the roster loads read-only',
      ),
    }
  }
  const summary = read.errors.map(issue => `${issue.path === '' ? 'root' : issue.path}: ${issue.msg}`).join('; ')
  return {
    ok: false,
    code: 'roster-unavailable',
    detail: truncate(`roster is unavailable: corrupted roster — ${summary}`),
  }
}
