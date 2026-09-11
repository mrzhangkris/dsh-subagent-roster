/**
 * Roster data-model contract tests (Task 2).
 *
 * These specify `src/schema.ts`: the shared, dependency-free roster schema,
 * the same-source validator consumed by both host and client halves, and the
 * default-filling normalizer. Paths in validation issues use the indexed
 * form (`agents[2].name`) so settings UIs can point at the exact field.
 */
import { describe, expect, it } from 'vitest'
import { ROSTER_NS, normalizeAgent, validateRoster } from '../src/schema.ts'

/** A valid roster agent; overrides replace whole fields. */
function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'scout', description: 'A fast scout', persona: 'You are a scout.', ...overrides }
}

/** A minimal valid roster config. */
function config(overrides: Record<string, unknown> = {}): unknown {
  return { schemaVersion: 1, agents: [agent()], ...overrides }
}

function paths(result: { errors: { path: string }[]; warnings: { path: string }[] }): {
  errors: string[]
  warnings: string[]
} {
  return { errors: result.errors.map(e => e.path), warnings: result.warnings.map(w => w.path) }
}

describe('ROSTER_NS', () => {
  it('matches the settings namespace', () => {
    expect(ROSTER_NS).toBe('subagent-roster')
  })
})

describe('validateRoster', () => {
  it('accepts a minimal valid config', () => {
    const result = validateRoster(config())
    expect(result).toEqual({ ok: true, readonly: false, errors: [], warnings: [] })
  })

  it('accepts a roster omitting every field that carries a default', () => {
    const result = validateRoster(config({ agents: [agent({
      modelPolicy: undefined,
      maxDepth: undefined,
      backgroundMode: undefined,
      fallback: undefined,
      enabled: undefined,
    })], transport: undefined, autoChain: undefined }))
    expect(paths(result).errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('rejects non-object input', () => {
    for (const raw of [null, 42, 'roster', [], true]) {
      const result = validateRoster(raw)
      expect(result.ok, `input ${JSON.stringify(raw)}`).toBe(false)
      expect(result.readonly, `input ${JSON.stringify(raw)}`).toBe(false)
      expect(result.errors.length, `input ${JSON.stringify(raw)}`).toBeGreaterThanOrEqual(1)
    }
  })

  it('requires schemaVersion to be present and exactly 1', () => {
    const missing = validateRoster({ agents: [] })
    expect(paths(missing).errors).toContain('schemaVersion')

    const zero = validateRoster({ schemaVersion: 0, agents: [] })
    expect(paths(zero).errors).toContain('schemaVersion')
    expect(zero.readonly).toBe(false)
  })

  it('loads schemaVersion > 1 as read-only without errors', () => {
    const result = validateRoster(config({ schemaVersion: 2 }))
    expect(result.ok).toBe(false)
    expect(result.readonly).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('rejects an empty or whitespace-only name', () => {
    const result = validateRoster(config({ agents: [agent({ name: '   ' })] }))
    expect(paths(result).errors).toContain('agents[0].name')
  })

  it('reports one error per duplicate name occurrence', () => {
    const result = validateRoster(config({ agents: [agent(), agent({ name: ' scout ' }), agent()] }))
    expect(result.ok).toBe(false)
    expect(paths(result).errors).toEqual(['agents[0].name', 'agents[1].name', 'agents[2].name'])
  })

  it('rejects missing or blank descriptions', () => {
    const missing = validateRoster(config({ agents: [{ name: 'x', persona: 'p' }] }))
    expect(paths(missing).errors).toContain('agents[0].description')

    const blank = validateRoster(config({ agents: [agent({ description: ' \n ' })] }))
    expect(paths(blank).errors).toContain('agents[0].description')
  })

  it('rejects descriptions over 100 characters', () => {
    const result = validateRoster(config({ agents: [agent({ description: 'x'.repeat(101) })] }))
    expect(paths(result).errors).toContain('agents[0].description')

    const fits = validateRoster(config({ agents: [agent({ description: 'x'.repeat(100) })] }))
    expect(paths(fits).errors).toEqual([])
  })

  it('rejects missing, blank, or over-long personas', () => {
    const missing = validateRoster(config({ agents: [{ name: 'x', description: 'd' }] }))
    expect(paths(missing).errors).toContain('agents[0].persona')

    const blank = validateRoster(config({ agents: [agent({ persona: '' })] }))
    expect(paths(blank).errors).toContain('agents[0].persona')

    const long = validateRoster(config({ agents: [agent({ persona: 'x'.repeat(20001) })] }))
    expect(paths(long).errors).toContain('agents[0].persona')

    const fits = validateRoster(config({ agents: [agent({ persona: 'x'.repeat(20000) })] }))
    expect(paths(fits).errors).toEqual([])
  })

  it('rejects unknown modelPolicy values but allows omission', () => {
    const bad = validateRoster(config({ agents: [agent({ modelPolicy: 'smart' })] }))
    expect(paths(bad).errors).toContain('agents[0].modelPolicy')

    const omitted = validateRoster(config({ agents: [agent()] }))
    expect(paths(omitted).errors).toEqual([])
  })

  it('requires provider and model when modelPolicy is fixed', () => {
    const result = validateRoster(config({ agents: [agent({ modelPolicy: 'fixed' })] }))
    expect(paths(result).errors).toEqual(['agents[0].provider', 'agents[0].model'])

    const blank = validateRoster(config({ agents: [agent({ modelPolicy: 'fixed', provider: '  ', model: 'glm-5.3' })] }))
    expect(paths(blank).errors).toEqual(['agents[0].provider'])

    const complete = validateRoster(config({ agents: [agent({ modelPolicy: 'fixed', provider: 'deepseek', model: 'glm-5.3' })] }))
    expect(paths(complete).errors).toEqual([])
  })

  it('rejects maxDepth that is not an integer ≥ 1', () => {
    const zero = validateRoster(config({ agents: [agent({ maxDepth: 0 })] }))
    expect(paths(zero).errors).toContain('agents[0].maxDepth')

    const fractional = validateRoster(config({ agents: [agent({ maxDepth: 1.5 })] }))
    expect(paths(fractional).errors).toContain('agents[0].maxDepth')
  })

  it('treats maxTokens as an optional nullable positive integer', () => {
    const zero = validateRoster(config({ agents: [agent({ maxTokens: 0 })] }))
    expect(paths(zero).errors).toContain('agents[0].maxTokens')

    const fractional = validateRoster(config({ agents: [agent({ maxTokens: 2.5 })] }))
    expect(paths(fractional).errors).toContain('agents[0].maxTokens')

    const fine = validateRoster(config({ agents: [agent({ maxTokens: null })] }))
    expect(paths(fine).errors).toEqual([])

    const positive = validateRoster(config({ agents: [agent({ maxTokens: 4096 })] }))
    expect(paths(positive).errors).toEqual([])
  })

  it('rejects a toolFilter defining both deny and allow', () => {
    const result = validateRoster(config({ agents: [agent({ toolFilter: { deny: ['bash'], allow: ['read'] } })] }))
    expect(paths(result).errors).toContain('agents[0].toolFilter')
  })

  it('rejects a toolFilter with neither key and non-object toolFilters', () => {
    const neither = validateRoster(config({ agents: [agent({ toolFilter: {} })] }))
    expect(paths(neither).errors).toContain('agents[0].toolFilter')

    const notObject = validateRoster(config({ agents: [agent({ toolFilter: 'no-tools' })] }))
    expect(paths(notObject).errors).toContain('agents[0].toolFilter')

    const nil = validateRoster(config({ agents: [agent({ toolFilter: null })] }))
    expect(paths(nil).errors).toEqual([])
  })

  it('rejects empty or non-string deny/allow arrays', () => {
    const empty = validateRoster(config({ agents: [agent({ toolFilter: { deny: [] } })] }))
    expect(paths(empty).errors).toContain('agents[0].toolFilter.deny')

    const nonString = validateRoster(config({ agents: [agent({ toolFilter: { allow: ['read', 3] } })] }))
    expect(paths(nonString).errors).toContain('agents[0].toolFilter.allow[1]')
  })

  it('warns on empty-string tool names without failing validation', () => {
    const result = validateRoster(config({ agents: [agent({ toolFilter: { deny: ['', 'bash'] } })] }))
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(paths(result).warnings).toEqual(['agents[0].toolFilter.deny[0]'])
  })

  it('warns when icon is longer than a single emoji', () => {
    const flagEmoji = validateRoster(config({ agents: [agent({ icon: '🇺🇳' })] })) // 4 UTF-16 units
    expect(paths(flagEmoji).warnings).toEqual([])

    const phrase = validateRoster(config({ agents: [agent({ icon: 'not-an-emoji' })] }))
    expect(paths(phrase).warnings).toEqual(['agents[0].icon'])
    expect(phrase.ok).toBe(true)
  })

  it('rejects unknown transport values but allows omission', () => {
    const bad = validateRoster(config({ transport: 'ssh' }))
    expect(paths(bad).errors).toContain('transport')

    const omitted = validateRoster({ schemaVersion: 1, agents: [] })
    expect(paths(omitted).errors).toEqual([])
  })

  it('rejects unknown backgroundMode and fallback values', () => {
    const badMode = validateRoster(config({ agents: [agent({ backgroundMode: 'detached' })] }))
    expect(paths(badMode).errors).toContain('agents[0].backgroundMode')

    const badFallback = validateRoster(config({ agents: [agent({ fallback: 'ignore' })] }))
    expect(paths(badFallback).errors).toContain('agents[0].fallback')

    const valid = validateRoster(config({ agents: [agent({ backgroundMode: 'one-shot', fallback: 'inherit' })] }))
    expect(paths(valid).errors).toEqual([])
  })

  it('rejects a non-boolean enabled flag', () => {
    const result = validateRoster(config({ agents: [agent({ enabled: 'yes' })] }))
    expect(paths(result).errors).toContain('agents[0].enabled')
  })

  it('rejects agent entries that are not objects', () => {
    const result = validateRoster(config({ agents: [42] }))
    expect(paths(result).errors).toContain('agents[0]')
  })

  it('caps the roster at 50 agents', () => {
    const tooMany = validateRoster(config({
      agents: Array.from({ length: 51 }, (_, i) => agent({ name: `a${i}` })),
    }))
    expect(paths(tooMany).errors).toContain('agents')

    const fits = validateRoster(config({
      agents: Array.from({ length: 50 }, (_, i) => agent({ name: `a${i}` })),
    }))
    expect(paths(fits).errors).toEqual([])
  })

  it('requires provider and model on every autoChain entry', () => {
    const missingModel = validateRoster(config({ autoChain: [{ provider: 'deepseek' }] }))
    expect(paths(missingModel).errors).toContain('autoChain[0].model')

    const blank = validateRoster(config({ autoChain: [{ provider: 'deepseek', model: '  ' }] }))
    expect(paths(blank).errors).toContain('autoChain[0].model')

    const notArray = validateRoster(config({ autoChain: 'fallback' }))
    expect(paths(notArray).errors).toContain('autoChain')

    const fine = validateRoster(config({ autoChain: [{ provider: 'deepseek', model: 'glm-5.3' }] }))
    expect(paths(fine).errors).toEqual([])
  })

  it('never rewrites the input object', () => {
    const raw = config({ agents: [agent({ toolFilter: { deny: ['bash'] }, icon: 'abcde' })] })
    const snapshot = structuredClone(raw)
    const result = validateRoster(raw)
    expect(raw).toEqual(snapshot)
    expect(result.ok).toBe(true) // only a warning fired; input untouched either way
  })
})

describe('normalizeAgent', () => {
  it('fills every documented default', () => {
    const agent = normalizeAgent({ name: 'scout', description: 'd', persona: 'p' })
    expect(agent).toEqual({
      name: 'scout',
      description: 'd',
      persona: 'p',
      modelPolicy: 'inherit',
      maxDepth: 3,
      backgroundMode: 'continuable',
      fallback: 'error',
      enabled: true,
    })
  })

  it('survives non-object input and fills the full default shape', () => {
    expect(normalizeAgent(null)).toEqual({
      name: '',
      description: '',
      persona: '',
      modelPolicy: 'inherit',
      maxDepth: 3,
      backgroundMode: 'continuable',
      fallback: 'error',
      enabled: true,
    })
  })

  it('preserves provided values and defensively copies toolFilter arrays', () => {
    const raw = {
      name: 'engineer',
      description: 'd',
      persona: 'p',
      modelPolicy: 'fixed',
      provider: 'deepseek',
      model: 'glm-5.3',
      reasoningEffort: 'high',
      maxTokens: 8192,
      toolFilter: { deny: ['bash'] },
      maxDepth: 2,
      backgroundMode: 'one-shot',
      fallback: 'inherit',
      enabled: false,
    }
    const snapshot = structuredClone(raw)
    const agent = normalizeAgent(raw)
    expect(agent.modelPolicy).toBe('fixed')
    expect(agent.provider).toBe('deepseek')
    expect(agent.model).toBe('glm-5.3')
    expect(agent.reasoningEffort).toBe('high')
    expect(agent.maxTokens).toBe(8192)
    expect(agent.toolFilter).toEqual({ deny: ['bash'] })
    expect(agent.maxDepth).toBe(2)
    expect(agent.backgroundMode).toBe('one-shot')
    expect(agent.fallback).toBe('inherit')
    expect(agent.enabled).toBe(false)
    expect(raw).toEqual(snapshot)
    expect(agent.toolFilter?.deny).not.toBe((raw.toolFilter as { deny: string[] }).deny)
  })

  it('keeps explicit nulls for nullable fields and drops invalid shapes', () => {
    const nulled = normalizeAgent({ name: 'x', description: 'd', persona: 'p', maxTokens: null, toolFilter: null })
    expect(nulled.maxTokens).toBeNull()
    expect(nulled.toolFilter).toBeNull()

    const invalid = normalizeAgent({ name: 'x', description: 'd', persona: 'p', toolFilter: { deny: ['a'], allow: ['b'] } })
    expect(invalid.toolFilter).toBeUndefined()
  })
})
