/**
 * Settings registration + hot roster read (Task 3).
 *
 * These specify two layers:
 * - `src/roster-read.ts` — the pure read pipeline `readRoster` (zero host
 *   dependencies, shared by host and client): validation + normalization
 *   with the empty-roster-is-legal ruling.
 * - `src/settings.ts` — the host-side thin wrapper: `RosterSettingsSchema`
 *   (schemastery mirror of RosterConfig), `registerRosterSettings` (the
 *   `ctx.inject(['settings'], ...)` + `installSection` seam), and the hot
 *   readers `getRoster` (always re-reads the current source) and
 *   `onRosterChange` (subscribe/unsubscribe).
 *
 * The settings provider is faked with a hook-capturing stub: the real
 * `SettingsProvider.installSection` contract used here is (owner, ns, schema,
 * entry, hooks) with `setSource`/`onChange`/`validate` hooks, per the
 * @deepseek-ai/dsh-settings 0.1.5-rc.1 surface.
 */
import { describe, expect, it } from 'vitest'
import { ROSTER_NS, type RosterConfig } from '../src/schema.ts'
import { readRoster } from '../src/roster-read.ts'
import { getRoster, onRosterChange, registerRosterSettings, RosterSettingsSchema } from '../src/settings.ts'

/** The fully-default roster every empty/default form must resolve to. */
const DEFAULT_ROSTER: RosterConfig = {
  schemaVersion: 1,
  transport: 'spawn',
  agents: [],
  autoChain: [],
}

/** A valid minimal agent: required strings only, every defaulted field absent. */
function rawAgent(): Record<string, unknown> {
  return { name: 'scout', description: 'A fast scout', persona: 'You are a scout.' }
}

/** A resolved (schema-defaults-filled) roster section, as the provider hands it to `validate`. */
function resolvedSection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    transport: 'spawn',
    agents: [],
    autoChain: [],
    ...overrides,
  }
}

/** Hook-capturing fake of the host settings seam. */
function makeHost() {
  interface RecordedHooks {
    validate?: (value: unknown) => void
    setSource: (current: () => unknown) => void
    onChange: () => void
  }
  interface Recorded {
    ns: string
    schema: unknown
    entry: unknown
    hooks: RecordedHooks
  }
  const registrations: Recorded[] = []
  const injected: string[][] = []
  const settings = {
    installSection(_owner: unknown, ns: string, schema: unknown, entry: unknown, hooks: RecordedHooks): void {
      registrations.push({ ns, schema, entry, hooks })
    },
  }
  const ctx = {
    settings,
    inject(deps: string[], callback: (c: unknown) => void): void {
      injected.push([...deps])
      callback(ctx)
    },
  }
  return { ctx, injected, registrations }
}

describe('readRoster — empty/default rosters are legal', () => {
  it('accepts undefined source as the fully-default roster', () => {
    expect(readRoster(undefined)).toEqual({ ok: true, roster: DEFAULT_ROSTER })
  })

  it('accepts an empty object source as the fully-default roster', () => {
    expect(readRoster({})).toEqual({ ok: true, roster: DEFAULT_ROSTER })
  })

  it('accepts schemaVersion-only source (no agents field) as the fully-default roster', () => {
    expect(readRoster({ schemaVersion: 1 })).toEqual({ ok: true, roster: DEFAULT_ROSTER })
  })
})

describe('readRoster — valid roster', () => {
  it('normalizes one inherit agent to complete fields with defaults filled', () => {
    const result = readRoster({ schemaVersion: 1, agents: [rawAgent()] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.roster.schemaVersion).toBe(1)
    expect(result.roster.transport).toBe('spawn')
    expect(result.roster.autoChain).toEqual([])
    const [agent] = result.roster.agents
    expect(agent).toBeDefined()
    if (!agent) return
    expect(agent.name).toBe('scout')
    expect(agent.modelPolicy).toBe('inherit')
    expect('icon' in agent).toBe(false)
    expect(agent.maxDepth).toBe(3)
    expect(agent.backgroundMode).toBe('continuable')
    expect(agent.fallback).toBe('error')
    expect(agent.enabled).toBe(true)
  })

  it('never mutates the source it reads', () => {
    const source = { schemaVersion: 1, agents: [rawAgent()] }
    const snapshot = JSON.stringify(source)
    readRoster(source)
    expect(JSON.stringify(source)).toBe(snapshot)
  })
})

describe('readRoster — read-only future schema', () => {
  it('maps schemaVersion 2 to the readonly branch without a roster key', () => {
    const result = readRoster({ schemaVersion: 2, agents: [rawAgent()] })
    expect(result.ok).toBe(false)
    expect('readonly' in result && result.readonly).toBe(true)
    expect('roster' in result).toBe(false)
    expect('errors' in result).toBe(false)
  })
})

describe('readRoster — corrupted roster', () => {
  it('locates a fixed-policy agent missing its provider at agents[0].provider', () => {
    const result = readRoster({
      schemaVersion: 1,
      agents: [{ ...rawAgent(), modelPolicy: 'fixed' }],
    })
    expect(result.ok).toBe(false)
    if (result.ok || result.readonly) return
    expect(result.errors.some(e => e.path === 'agents[0].provider')).toBe(true)
  })
})

describe('registerRosterSettings — installSection seam', () => {
  it('registers the roster namespace through ctx.inject(["settings"]) with a RosterConfig entry', () => {
    const { ctx, injected, registrations } = makeHost()
    registerRosterSettings(ctx as never, {})
    expect(injected).toEqual([['settings']])
    expect(registrations.length).toBe(1)
    const registration = registrations[0]
    expect(registration).toBeDefined()
    if (!registration) return
    expect(registration.ns).toBe(ROSTER_NS)
    expect(registration.entry).toEqual(DEFAULT_ROSTER)
    expect(typeof registration.hooks.setSource).toBe('function')
    expect(typeof registration.hooks.onChange).toBe('function')
    expect(typeof registration.hooks.validate).toBe('function')
  })

  it('exposes a function-shaped schemastery schema that resolves the section defaults', () => {
    expect(['object', 'function']).toContain(typeof RosterSettingsSchema)
    // Schemastery schemas are callable: invoking one validates + resolves.
    const resolved = RosterSettingsSchema({}) as Record<string, unknown>
    expect(resolved).toMatchObject({ schemaVersion: 1, transport: 'spawn', agents: [], autoChain: [] })
  })
})

describe('getRoster — hot read semantics', () => {
  it('falls back to the composition entry before the settings service attaches', () => {
    const { ctx } = makeHost()
    registerRosterSettings(ctx as never, {})
    expect(getRoster()).toEqual({ ok: true, roster: DEFAULT_ROSTER })
  })

  it('re-reads the current source on every call with no caching', () => {
    const { ctx, registrations } = makeHost()
    registerRosterSettings(ctx as never, {})
    const registration = registrations[0]
    if (!registration) return

    const userSection = { schemaVersion: 1, agents: [rawAgent()] }
    registration.hooks.setSource(() => userSection)
    registration.hooks.onChange()

    const first = getRoster()
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.roster.agents.length).toBe(1)

    // Simulate a committed provider change (a second agent appears) without
    // re-registering: the next getRoster must see it — no snapshot caching.
    userSection.agents.push({ name: 'second', description: 'Another agent', persona: 'You are second.' })
    const second = getRoster()
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.roster.agents.length).toBe(2)
    expect(second.roster.agents[1]?.name).toBe('second')
  })
})

describe('onRosterChange — subscribe and unsubscribe', () => {
  it('fires on committed changes and stops after unsubscribing', () => {
    const { ctx, registrations } = makeHost()
    registerRosterSettings(ctx as never, {})
    const registration = registrations[0]
    if (!registration) return

    const seen: number[] = []
    const unsubscribe = onRosterChange(() => { seen.push(1) })

    registration.hooks.onChange()
    expect(seen).toEqual([1])

    unsubscribe()
    registration.hooks.onChange()
    expect(seen).toEqual([1])
  })
})

describe('settings validate hook', () => {
  it('accepts a resolved valid section', () => {
    const { ctx, registrations } = makeHost()
    registerRosterSettings(ctx as never, {})
    const registration = registrations[0]
    if (!registration) return
    expect(() => registration.hooks.validate?.(resolvedSection())).not.toThrow()
  })

  it('refuses the write for a fixed agent missing its provider', () => {
    const { ctx, registrations } = makeHost()
    registerRosterSettings(ctx as never, {})
    const registration = registrations[0]
    if (!registration) return
    const corrupted = resolvedSection({
      agents: [{ name: 'ops', description: 'Ops agent', persona: 'You are ops.', modelPolicy: 'fixed' }],
    })
    expect(() => registration.hooks.validate?.(corrupted)).toThrow(/agents\[0\]\.provider/)
  })

  it('refuses the write for a newer schema version (read-only)', () => {
    const { ctx, registrations } = makeHost()
    registerRosterSettings(ctx as never, {})
    const registration = registrations[0]
    if (!registration) return
    expect(() => registration.hooks.validate?.(resolvedSection({ schemaVersion: 2 }))).toThrow()
  })
})
