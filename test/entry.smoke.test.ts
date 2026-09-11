/**
 * Skeleton smoke test: the narrowed plugin entry must load and expose the
 * three host mount surfaces (tool registration runtime, capabilities, config
 * schema) without throwing. Task 2+ build TDD on top of this setup.
 */
import { describe, expect, it } from 'vitest'
import * as entry from '../src/index.ts'

describe('subagent-roster entry', () => {
  it('imports without throwing and exposes the plugin identity', () => {
    expect(entry.name).toBe('agent-teams')
    expect(typeof entry.apply).toBe('function')
    expect(entry.inject).toContain('tools')
  })

  it('exposes a config schema (schemastery schemas are function-shaped)', () => {
    expect(entry.Config).toBeDefined()
    expect(['object', 'function']).toContain(typeof entry.Config)
  })

  it('renders a usage section that mentions the remaining tools', () => {
    const text = entry.usageSectionText('agent_teams_create, agent_teams_status')
    expect(text).toContain('agent_teams_create')
    expect(text).toContain('agent_teams_status')
    expect(text).not.toContain('agent_teams_claim_task')
    expect(text).not.toContain('agent_teams_reassign_task')
  })
})
