/**
 * Roster resolve + capability-mapping contract tests (Task 4).
 *
 * These specify `src/roster.ts`: the pure lookup that turns a roster entry
 * (or a three-state `readRoster` result) into a `DispatchSpec` — the single
 * contract consumed by the dispatch tasks that follow. The behavior matrix
 * under test:
 * 1. not-found carries the current enabled names (truncated at 20, disabled excluded)
 * 2. disabled is a distinct code from not-found
 * 3. inherit: agentOptions without provider/model; reasoningEffort/maxTokens kept when configured
 * 4. fixed: agentOptions with provider+model
 * 5. auto: autoCandidates in autoChain order; agentOptions without routing
 * 6. label: `${icon} ${name}`, bare name when icon is absent/empty
 * 7. capabilitiesNeeded collection rules
 * 8. resolveFromRead: readonly/errors → roster-unavailable (detail summary ≤ 200 chars)
 */
import { describe, expect, it } from 'vitest'
import { normalizeAgent, type RosterAgent, type RosterConfig } from '../src/schema.ts'
import { readRoster } from '../src/roster-read.ts'
import { resolveAgent, resolveFromRead } from '../src/roster.ts'

/** A complete defaults-filled agent (mirrors what readRoster stores). */
function entry(overrides: Partial<RosterAgent> = {}): RosterAgent {
  return normalizeAgent({ name: '百晓', description: 'A scout', persona: 'You are 百晓.', ...overrides })
}

/** A roster config holding exactly the given agents. */
function roster(agents: RosterAgent[], autoChain: RosterConfig['autoChain'] = []): RosterConfig {
  return { schemaVersion: 1, transport: 'spawn', agents, autoChain }
}

/** Pull the spec out of a successful resolve, failing the test otherwise. */
function specOf(result: ReturnType<typeof resolveAgent>): ReturnType<typeof extractSpec> {
  return extractSpec(result)
}

function extractSpec(result: ReturnType<typeof resolveAgent>) {
  if (!result.ok || result.spec === undefined) throw new Error(`expected ok spec, got ${JSON.stringify(result)}`)
  return result.spec
}

describe('resolveAgent — lookup failures', () => {
  it('reports not-found with the enabled names only, truncated at 20', () => {
    const agents = Array.from({ length: 25 }, (_, i) => entry({ name: `agent-${String(i).padStart(2, '0')}` }))
    const result = resolveAgent(roster(agents), 'missing')
    expect(result).toMatchObject({ ok: false, code: 'not-found' })
    if (result.ok) return
    expect(result.available).toHaveLength(20)
    expect(result.available[0]).toBe('agent-00')
    expect(result.available[19]).toBe('agent-19')
    expect(result.available).not.toContain('agent-20') // the 21st enabled name never appears
    expect(result.available).not.toContain('missing')
  })

  it('excludes disabled names from the not-found available list', () => {
    const agents = [
      entry({ name: 'on-a' }),
      entry({ name: 'off-a', enabled: false }),
      entry({ name: 'on-b' }),
    ]
    const result = resolveAgent(roster(agents), 'nobody')
    if (result.ok || result.code !== 'not-found') throw new Error(JSON.stringify(result))
    expect(result.available).toEqual(['on-a', 'on-b'])
  })

  it('reports disabled as its own code, distinct from not-found', () => {
    const agents = [entry({ name: 'off', enabled: false }), entry({ name: 'on' })]
    const result = resolveAgent(roster(agents), 'off')
    expect(result).toMatchObject({ ok: false, code: 'disabled' })
    if (result.ok || result.code !== 'disabled') throw new Error(JSON.stringify(result))
    expect(result.available).toEqual(['on']) // enabled names only — the disabled target is not listed
  })
})

describe('resolveAgent — label', () => {
  it('joins icon and name with a single space', () => {
    const spec = specOf(resolveAgent(roster([entry({ icon: '📚' })]), '百晓'))
    expect(spec.label).toBe('📚 百晓')
  })

  it('falls back to the bare name when icon is absent or empty', () => {
    expect(specOf(resolveAgent(roster([entry()]), '百晓')).label).toBe('百晓')
    expect(specOf(resolveAgent(roster([entry({ icon: '' })]), '百晓')).label).toBe('百晓')
  })
})

describe('resolveAgent — model policy mapping', () => {
  it('inherit: keeps configured reasoningEffort/maxTokens, drops routing', () => {
    const spec = specOf(resolveAgent(roster([entry({
      modelPolicy: 'inherit',
      reasoningEffort: 'high',
      maxTokens: 8000,
    })]), '百晓'))
    expect(spec.agentOptions).toEqual({ reasoningEffort: 'high', maxTokens: 8000 })
    expect(spec.agentOptions).not.toHaveProperty('provider')
    expect(spec.agentOptions).not.toHaveProperty('model')
  })

  it('inherit without extras: agentOptions is absent', () => {
    const spec = specOf(resolveAgent(roster([entry({ modelPolicy: 'inherit' })]), '百晓'))
    expect(spec.agentOptions).toBeUndefined()
  })

  it('fixed: agentOptions carries provider and model', () => {
    const spec = specOf(resolveAgent(roster([entry({
      modelPolicy: 'fixed',
      provider: 'deepseek',
      model: 'glm-5.3-flash',
    })]), '百晓'))
    expect(spec.agentOptions).toMatchObject({ provider: 'deepseek', model: 'glm-5.3-flash' })
  })

  it('auto: autoCandidates preserve the autoChain order; agentOptions has no routing', () => {
    const spec = specOf(resolveAgent(roster([entry({ modelPolicy: 'auto', fallback: 'inherit' })], [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
    ]), '百晓'))
    expect(spec.autoCandidates).toEqual([
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
    ])
    expect(spec.fallback).toBe('inherit')
    expect(spec.agentOptions).not.toHaveProperty('provider')
    expect(spec.agentOptions).not.toHaveProperty('model')
  })

  it('auto without an extra knob still exposes agentOptions (empty) for the post-precheck route', () => {
    const spec = specOf(resolveAgent(roster([entry({ modelPolicy: 'auto' })]), '百晓'))
    expect(spec.agentOptions).toEqual({})
    expect(spec.autoCandidates).toEqual([])
  })

  it('fixed/auto/inherit values land verbatim on the spec', () => {
    const spec = specOf(resolveAgent(roster([entry({
      maxDepth: 5,
      backgroundMode: 'one-shot',
      fallback: 'inherit',
    })]), '百晓'))
    expect(spec.name).toBe('百晓')
    expect(spec.persona).toBe('You are 百晓.')
    expect(spec.maxDepth).toBe(5)
    expect(spec.backgroundMode).toBe('one-shot')
    expect(spec.fallback).toBe('inherit')
  })
})

describe('resolveAgent — capabilitiesNeeded', () => {
  it('persona is always needed', () => {
    const spec = specOf(resolveAgent(roster([entry({
      backgroundMode: 'one-shot',
    })]), '百晓'))
    expect(spec.capabilitiesNeeded).toEqual(['persona'])
  })

  it('collects agentOptions for fixed and auto policies', () => {
    const fixed = specOf(resolveAgent(roster([entry({ modelPolicy: 'fixed', provider: 'p', model: 'm' })]), '百晓'))
    expect(fixed.capabilitiesNeeded).toContain('agentOptions')
    const auto = specOf(resolveAgent(roster([entry({ modelPolicy: 'auto' })]), '百晓'))
    expect(auto.capabilitiesNeeded).toContain('agentOptions')
  })

  it('collects agentOptions for inherit only when reasoningEffort/maxTokens are configured', () => {
    const bare = specOf(resolveAgent(roster([entry({ modelPolicy: 'inherit' })]), '百晓'))
    expect(bare.capabilitiesNeeded).not.toContain('agentOptions')

    const withEffort = specOf(resolveAgent(roster([entry({ reasoningEffort: 'low' })]), '百晓'))
    expect(withEffort.capabilitiesNeeded).toContain('agentOptions')

    const withTokens = specOf(resolveAgent(roster([entry({ maxTokens: 4096 })]), '百晓'))
    expect(withTokens.capabilitiesNeeded).toContain('agentOptions')
  })

  it('collects toolFilter when set, depthLimit when maxDepth ≠ 3, continuable when durable', () => {
    const filtered = specOf(resolveAgent(roster([entry({ toolFilter: { deny: ['bash'] } })]), '百晓'))
    expect(filtered.capabilitiesNeeded).toContain('toolFilter')

    const allowListed = specOf(resolveAgent(roster([entry({ toolFilter: { allow: ['read'] } })]), '百晓'))
    expect(allowListed.capabilitiesNeeded).toContain('toolFilter')

    const deep = specOf(resolveAgent(roster([entry({ maxDepth: 5 })]), '百晓'))
    expect(deep.capabilitiesNeeded).toContain('depthLimit')

    const shallow = specOf(resolveAgent(roster([entry({ maxDepth: 3 })]), '百晓'))
    expect(shallow.capabilitiesNeeded).not.toContain('depthLimit')

    const durable = specOf(resolveAgent(roster([entry({ backgroundMode: 'continuable' })]), '百晓'))
    expect(durable.capabilitiesNeeded).toContain('continuable')

    const oneshot = specOf(resolveAgent(roster([entry({ backgroundMode: 'one-shot' })]), '百晓'))
    expect(oneshot.capabilitiesNeeded).not.toContain('continuable')
  })

  it('emits the full set in canonical order for a kitchen-sink agent', () => {
    const spec = specOf(resolveAgent(roster([entry({
      modelPolicy: 'fixed',
      provider: 'deepseek',
      model: 'glm-5.3-flash',
      toolFilter: { allow: ['read', 'grep'] },
      maxDepth: 2,
      backgroundMode: 'continuable',
    })]), '百晓'))
    expect(spec.capabilitiesNeeded).toEqual(['persona', 'agentOptions', 'toolFilter', 'depthLimit', 'continuable'])
    expect(spec.toolFilter).toEqual({ allow: ['read', 'grep'] })
  })
})

describe('resolveFromRead', () => {
  it('passes a healthy roster straight through to resolveAgent', () => {
    // `one-shot` so the capability list stays at the bare minimum; the
    // schema default backgroundMode is `continuable`, which adds `continuable`.
    const read = readRoster({ schemaVersion: 1, agents: [{ name: '百晓', description: 'd', persona: 'p', backgroundMode: 'one-shot' }] })
    const result = resolveFromRead(read, '百晓')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.name).toBe('百晓')
    expect(result.spec.label).toBe('百晓')
    expect(result.spec.capabilitiesNeeded).toEqual(['persona'])
  })

  it('propagates not-found through a healthy read', () => {
    const read = readRoster({ schemaVersion: 1, agents: [{ name: 'on', description: 'd', persona: 'p' }] })
    const result = resolveFromRead(read, 'ghost')
    expect(result).toMatchObject({ ok: false, code: 'not-found', available: ['on'] })
  })

  it('maps a read-only roster to roster-unavailable with a reason summary', () => {
    const read = readRoster({ schemaVersion: 2, agents: [] })
    const result = resolveFromRead(read, '百晓')
    expect(result).toMatchObject({ ok: false, code: 'roster-unavailable' })
    if (result.ok || result.code !== 'roster-unavailable') throw new Error(JSON.stringify(result))
    expect(result.detail.toLowerCase()).toContain('read-only')
    expect(result.detail.length).toBeLessThanOrEqual(200)
  })

  it('maps a corrupted roster to roster-unavailable with the issue summary, truncated at 200 chars', () => {
    // 12 agents each failing three required-field checks → summary far over 200 chars.
    const badAgents = Array.from({ length: 12 }, () => ({ name: '  ', description: ' ', persona: '' }))
    const read = readRoster({ schemaVersion: 1, agents: badAgents })
    expect(read.ok).toBe(false) // precondition: this source really is corrupted
    const result = resolveFromRead(read, '百晓')
    expect(result).toMatchObject({ ok: false, code: 'roster-unavailable' })
    if (result.ok || result.code !== 'roster-unavailable') throw new Error(JSON.stringify(result))
    expect(result.detail).toContain('agents[')
    expect(result.detail.length).toBe(200)
  })
})
