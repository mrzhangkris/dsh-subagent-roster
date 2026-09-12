/**
 * Skeleton smoke test: the narrowed plugin entry must load and expose the
 * host mount surfaces (tool registration, settings + section registration,
 * capabilities, config schema) without throwing. Task 2+ build TDD on top of
 * this setup.
 */
import { describe, expect, it } from 'vitest'
import * as entry from '../src/index.ts'
import { ROSTER_USAGE_PROMPT, ROSTER_USAGE_SECTION_NAME } from '../src/capabilities.ts'

describe('subagent-roster entry', () => {
  it('imports without throwing and exposes the plugin identity', () => {
    expect(entry.name).toBe('subagent-roster')
    expect(typeof entry.apply).toBe('function')
    expect(entry.inject).toContain('tools')
  })

  it('exposes a config schema (schemastery schemas are function-shaped)', () => {
    expect(entry.Config).toBeDefined()
    expect(['object', 'function']).toContain(typeof entry.Config)
  })

  it('ships a usage policy that names the roster tools under a roster-namespaced section', () => {
    expect(ROSTER_USAGE_SECTION_NAME).toBe('subagent-roster:usage')
    expect(ROSTER_USAGE_PROMPT).toContain('roster_agent')
    expect(ROSTER_USAGE_PROMPT).toContain('roster_list')
  })
})
