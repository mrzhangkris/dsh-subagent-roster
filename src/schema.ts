/**
 * Roster data model and same-source validator.
 *
 * This module is the roster contract shared by both halves of the plugin:
 * the host plane (settings registration, spawning, dispatch) and the client
 * half (web panel) import this exact file. It is therefore deliberately
 * dependency-free — zero imports, no host, no cordis, no DOM — so it can be
 * compiled into either build and unit-tested in isolation.
 *
 * Division of labor:
 * - `validateRoster` answers "is this stored/edited config structurally
 *   valid?" and never mutates or rewrites its input. Fields that carry
 *   defaults may be absent; only present-but-invalid values are errors.
 * - `normalizeAgent` turns a validated raw agent into a complete
 *   `RosterAgent` by filling the documented defaults; consumers call it
 *   after a successful validation.
 * - A stored config with `schemaVersion` greater than 1 is newer than this
 *   build: it loads read-only (`readonly: true`, `ok: false`) instead of
 *   producing validation noise, so a downgrade never corrupts user data.
 */

/** Settings namespace and storage key prefix for the roster. */
export const ROSTER_NS = 'subagent-roster'

/** Structural limits enforced by `validateRoster`; exported for settings UIs. */
export const ROSTER_LIMITS = {
  /** Maximum agents per roster. */
  maxAgents: 50,
  /** Maximum `description` length in characters. */
  maxDescription: 100,
  /** Soft cap for `persona` length in characters (validator-enforced). */
  maxPersona: 20_000,
  /** A single emoji fits in 4 UTF-16 code units; longer icons warn. */
  maxIconUnits: 4,
} as const

/** How the member's model is chosen. */
export type ModelPolicy = 'inherit' | 'fixed' | 'auto'
/** Durable (continuable) vs one-shot member execution. */
export type BackgroundMode = 'continuable' | 'one-shot'
/** Strategy when an `auto` model policy exhausts the chain. */
export type RosterFallback = 'error' | 'inherit'
/** Subagent transport used to create members. */
export type RosterTransport = 'spawn' | 'fork'
/** Tool gate: exactly one of deny/allow, never both. */
export type ToolFilter = { deny: string[] } | { allow: string[] }

/** One named roster entry: a durable, user-authored subagent identity. */
export interface RosterAgent {
  /** Unique key; non-empty after trim; duplicates are rejected per occurrence. */
  name: string
  /** Single emoji shown next to the member label; may be empty. */
  icon?: string
  /** Required, 1..100 characters. */
  description: string
  /** Required, 1..20000 characters (soft cap, validator-enforced). */
  persona: string
  /** Default `'inherit'`. */
  modelPolicy: ModelPolicy
  /** Required (non-empty) when `modelPolicy` is `'fixed'`. */
  provider?: string
  /** Required (non-empty) when `modelPolicy` is `'fixed'`. */
  model?: string
  /** Passed through verbatim; no enum validation at this layer. */
  reasoningEffort?: string
  /** Optional; when present (non-null) must be a positive integer. */
  maxTokens?: number | null
  /** Exactly one of deny/allow; never both. */
  toolFilter?: ToolFilter | null
  /** Delegation depth cap; integer ≥ 1, default `3`. */
  maxDepth: number
  /** Default `'continuable'`. */
  backgroundMode: BackgroundMode
  /** Default `'error'` (the all-failed strategy for `auto`). */
  fallback: RosterFallback
  /** Default `true`. */
  enabled: boolean
}

/** A fallback route in the auto-model chain; both keys are required. */
export interface RosterAutoChainRoute {
  provider: string
  model: string
}

/** Whole-roster configuration as stored under `ROSTER_NS`. */
export interface RosterConfig {
  /** Must be exactly `1` for this build; `> 1` loads read-only. */
  schemaVersion: number
  /** Default `'spawn'`. */
  transport: RosterTransport
  /** At most `ROSTER_LIMITS.maxAgents` entries. */
  agents: RosterAgent[]
  /** Auto-model fallback chain; every entry needs provider and model. */
  autoChain: RosterAutoChainRoute[]
}

/** One validation message, pointing at the offending field by index path. */
export interface RosterIssue {
  path: string
  msg: string
}

/** `validateRoster` result. `warnings` are advisory and never affect `ok`. */
export interface RosterValidation {
  ok: boolean
  /** True when the input is a newer schema than this build (read-only load). */
  readonly: boolean
  errors: RosterIssue[]
  warnings: RosterIssue[]
}

const MODEL_POLICIES: readonly ModelPolicy[] = ['inherit', 'fixed', 'auto']
const BACKGROUND_MODES: readonly BackgroundMode[] = ['continuable', 'one-shot']
const FALLBACK_POLICIES: readonly RosterFallback[] = ['error', 'inherit']
const TRANSPORTS: readonly RosterTransport[] = ['spawn', 'fork']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBlank(value: string): boolean {
  return value.trim() === ''
}

/** Integer ≥ 1 — the shared shape of `maxDepth` and non-null `maxTokens`. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * Validate a raw roster config (e.g. freshly read from settings storage or
 * user-edited JSON) without touching it. Absent fields with documented
 * defaults are accepted — the defaults are applied later by `normalizeAgent`
 * — but a present value must match its declared type and range. Empty-string
 * tool names and oversized icons downgrade to warnings: advisory, never `ok`
 * breaking. Errors point at the exact field via indexed paths like
 * `agents[2].name`.
 */
export function validateRoster(raw: unknown): RosterValidation {
  if (!isRecord(raw)) {
    return {
      ok: false,
      readonly: false,
      errors: [{ path: '', msg: 'roster config must be an object' }],
      warnings: [],
    }
  }

  // Future schema: recognized, not writable, and not validated with v1 rules.
  const version = raw['schemaVersion']
  if (typeof version === 'number' && version > 1) {
    return { ok: false, readonly: true, errors: [], warnings: [] }
  }

  const errors: RosterIssue[] = []
  const warnings: RosterIssue[] = []

  if (typeof version !== 'number' || version !== 1) {
    errors.push({ path: 'schemaVersion', msg: 'schemaVersion must be exactly 1' })
  }

  const transport = raw['transport']
  if (transport !== undefined && !TRANSPORTS.includes(transport as RosterTransport)) {
    errors.push({ path: 'transport', msg: `transport must be one of: ${TRANSPORTS.join(', ')}` })
  }

  // agents: absent roster = empty roster; present roster must be an array of
  // objects within the size cap.
  let agentEntries: unknown[] = []
  const agentsRaw = raw['agents']
  if (agentsRaw !== undefined) {
    if (!Array.isArray(agentsRaw)) {
      errors.push({ path: 'agents', msg: 'agents must be an array' })
    } else {
      agentEntries = agentsRaw
      if (agentEntries.length > ROSTER_LIMITS.maxAgents) {
        errors.push({
          path: 'agents',
          msg: `roster is capped at ${ROSTER_LIMITS.maxAgents} agents (got ${agentEntries.length})`,
        })
      }
    }
  }

  agentEntries.forEach((entry, index) => {
    const at = (field: string): string => field === '' ? `agents[${index}]` : `agents[${index}].${field}`
    if (!isRecord(entry)) {
      errors.push({ path: at(''), msg: 'agent entry must be an object' })
      return
    }

    const name = entry['name']
    if (typeof name !== 'string' || isBlank(name)) {
      errors.push({ path: at('name'), msg: 'name is required and must be non-empty after trim' })
    }

    const description = entry['description']
    if (typeof description !== 'string' || isBlank(description)) {
      errors.push({ path: at('description'), msg: 'description is required and must be non-empty after trim' })
    } else if (description.length > ROSTER_LIMITS.maxDescription) {
      errors.push({
        path: at('description'),
        msg: `description is capped at ${ROSTER_LIMITS.maxDescription} characters (got ${description.length})`,
      })
    }

    const persona = entry['persona']
    if (typeof persona !== 'string' || isBlank(persona)) {
      errors.push({ path: at('persona'), msg: 'persona is required and must be non-empty after trim' })
    } else if (persona.length > ROSTER_LIMITS.maxPersona) {
      errors.push({
        path: at('persona'),
        msg: `persona is capped at ${ROSTER_LIMITS.maxPersona} characters (got ${persona.length})`,
      })
    }

    const icon = entry['icon']
    if (icon !== undefined) {
      if (typeof icon !== 'string') {
        warnings.push({ path: at('icon'), msg: 'icon should be a single emoji string' })
      } else if (icon.length > ROSTER_LIMITS.maxIconUnits) {
        warnings.push({ path: at('icon'), msg: 'icon is longer than a single emoji (over 4 code units)' })
      }
    }

    const modelPolicy = entry['modelPolicy']
    if (modelPolicy !== undefined && !MODEL_POLICIES.includes(modelPolicy as ModelPolicy)) {
      errors.push({ path: at('modelPolicy'), msg: `modelPolicy must be one of: ${MODEL_POLICIES.join(', ')}` })
    }
    if (modelPolicy === 'fixed') {
      for (const field of ['provider', 'model'] as const) {
        const route = entry[field]
        if (typeof route !== 'string' || isBlank(route)) {
          errors.push({ path: at(field), msg: `modelPolicy=fixed requires a non-empty ${field}` })
        }
      }
    }
    // reasoningEffort is passed through verbatim: no validation at this layer.

    const maxTokens = entry['maxTokens']
    if (maxTokens !== undefined && maxTokens !== null && !isPositiveInteger(maxTokens)) {
      errors.push({ path: at('maxTokens'), msg: 'maxTokens must be a positive integer when present' })
    }

    const toolFilter = entry['toolFilter']
    if (toolFilter !== undefined && toolFilter !== null) {
      validateToolFilter(toolFilter, at, errors, warnings)
    }

    const maxDepth = entry['maxDepth']
    if (maxDepth !== undefined && !isPositiveInteger(maxDepth)) {
      errors.push({ path: at('maxDepth'), msg: 'maxDepth must be an integer ≥ 1' })
    }

    const backgroundMode = entry['backgroundMode']
    if (backgroundMode !== undefined && !BACKGROUND_MODES.includes(backgroundMode as BackgroundMode)) {
      errors.push({ path: at('backgroundMode'), msg: `backgroundMode must be one of: ${BACKGROUND_MODES.join(', ')}` })
    }

    const fallback = entry['fallback']
    if (fallback !== undefined && !FALLBACK_POLICIES.includes(fallback as RosterFallback)) {
      errors.push({ path: at('fallback'), msg: `fallback must be one of: ${FALLBACK_POLICIES.join(', ')}` })
    }

    const enabled = entry['enabled']
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      errors.push({ path: at('enabled'), msg: 'enabled must be a boolean' })
    }
  })

  // Duplicate names: report once per occurrence (an offending pair yields two
  // errors), so settings UIs can mark every field involved.
  const nameCounts = new Map<string, number>()
  for (const entry of agentEntries) {
    if (isRecord(entry) && typeof entry['name'] === 'string' && !isBlank(entry['name'])) {
      const key = entry['name'].trim()
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
    }
  }
  agentEntries.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string' || isBlank(entry['name'])) return
    const key = entry['name'].trim()
    if ((nameCounts.get(key) ?? 0) > 1) {
      errors.push({ path: `agents[${index}].name`, msg: `duplicate agent name "${key}"` })
    }
  })

  // autoChain: absent = empty chain; every present entry needs both keys.
  const autoChainRaw = raw['autoChain']
  if (autoChainRaw !== undefined) {
    if (!Array.isArray(autoChainRaw)) {
      errors.push({ path: 'autoChain', msg: 'autoChain must be an array' })
    } else {
      autoChainRaw.forEach((entry, index) => {
        if (!isRecord(entry)) {
          errors.push({ path: `autoChain[${index}]`, msg: 'autoChain entry must be an object' })
          return
        }
        for (const field of ['provider', 'model'] as const) {
          const value = entry[field]
          if (typeof value !== 'string' || isBlank(value)) {
            errors.push({ path: `autoChain[${index}].${field}`, msg: `autoChain entry requires a non-empty ${field}` })
          }
        }
      })
    }
  }

  return { ok: errors.length === 0, readonly: false, errors, warnings }
}

function validateToolFilter(
  value: unknown,
  at: (field: string) => string,
  errors: RosterIssue[],
  warnings: RosterIssue[],
): void {
  if (!isRecord(value)) {
    errors.push({ path: at('toolFilter'), msg: 'toolFilter must be an object with a single deny or allow key' })
    return
  }
  const hasDeny = value['deny'] !== undefined
  const hasAllow = value['allow'] !== undefined
  if (hasDeny && hasAllow) {
    errors.push({ path: at('toolFilter'), msg: 'toolFilter cannot define both deny and allow' })
    return
  }
  if (!hasDeny && !hasAllow) {
    errors.push({ path: at('toolFilter'), msg: 'toolFilter must define either deny or allow' })
    return
  }
  const key = hasDeny ? 'deny' : 'allow'
  const list = value[key]
  if (!Array.isArray(list)) {
    errors.push({ path: at(`toolFilter.${key}`), msg: `${key} must be an array of tool names` })
    return
  }
  if (list.length === 0) {
    errors.push({ path: at(`toolFilter.${key}`), msg: `${key} must not be empty` })
    return
  }
  // Tool existence is a host-layer concern; here an empty-string entry is
  // only a warning (a name that matches nothing), a non-string is an error.
  list.forEach((item, itemIndex) => {
    if (typeof item !== 'string') {
      errors.push({ path: at(`toolFilter.${key}[${itemIndex}]`), msg: 'tool names must be strings' })
    } else if (item === '') {
      warnings.push({ path: at(`toolFilter.${key}[${itemIndex}]`), msg: 'empty tool name has no effect' })
    }
  })
}

/**
 * Fill the documented defaults into a raw agent, returning a new object —
 * the input is never rewritten (mirrors `validateRoster`'s no-mutation
 * guarantee). Call after `validateRoster` reports `ok: true`; unexpected
 * input shapes degrade to the defaults rather than throwing.
 */
export function normalizeAgent(raw: unknown): RosterAgent {
  const source = isRecord(raw) ? raw : {}
  const agent: RosterAgent = {
    name: typeof source['name'] === 'string' ? source['name'] : '',
    description: typeof source['description'] === 'string' ? source['description'] : '',
    persona: typeof source['persona'] === 'string' ? source['persona'] : '',
    modelPolicy: MODEL_POLICIES.includes(source['modelPolicy'] as ModelPolicy)
      ? source['modelPolicy'] as ModelPolicy
      : 'inherit',
    maxDepth: isPositiveInteger(source['maxDepth']) ? source['maxDepth'] : 3,
    backgroundMode: BACKGROUND_MODES.includes(source['backgroundMode'] as BackgroundMode)
      ? source['backgroundMode'] as BackgroundMode
      : 'continuable',
    fallback: FALLBACK_POLICIES.includes(source['fallback'] as RosterFallback)
      ? source['fallback'] as RosterFallback
      : 'error',
    enabled: typeof source['enabled'] === 'boolean' ? source['enabled'] : true,
  }
  if (typeof source['icon'] === 'string') agent.icon = source['icon']
  if (typeof source['provider'] === 'string' && source['provider'] !== '') agent.provider = source['provider']
  if (typeof source['model'] === 'string' && source['model'] !== '') agent.model = source['model']
  if (typeof source['reasoningEffort'] === 'string') agent.reasoningEffort = source['reasoningEffort']
  if (typeof source['maxTokens'] === 'number' || source['maxTokens'] === null) agent.maxTokens = source['maxTokens']
  const toolFilter = source['toolFilter']
  if (toolFilter === null) {
    agent.toolFilter = null
  } else if (isRecord(toolFilter)) {
    const deny = toolFilter['deny']
    const allow = toolFilter['allow']
    if (isStringArray(deny) && allow === undefined) {
      agent.toolFilter = { deny: [...deny] }
    } else if (isStringArray(allow) && deny === undefined) {
      agent.toolFilter = { allow: [...allow] }
    }
  }
  return agent
}
