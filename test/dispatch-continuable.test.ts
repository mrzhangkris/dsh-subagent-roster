/**
 * Continuable dispatch contract tests (Task 5).
 *
 * These specify `src/dispatch.ts`: the single seam between a resolved
 * `DispatchSpec` and the host `ctx.subagents.startContinuable` call. Field
 * names follow the fork's own `spawnMember` call surface (`members.ts`) and
 * the host `ContinuableStartSpec` shape, NOT the flat field list assumed in
 * the brief — the request is nested, and the initial prompt is a
 * `ContentBlock[]` (`[{ type: 'text', text }]`), not a bare string.
 *
 * Behavior matrix:
 * 1. parent defense: missing parent → throw mentioning "parent", no request issued
 * 2. request construction: transport→provider, spec.label→label,
 *    spec.persona→request.persona, prompt→request.prompt ContentBlock,
 *    spec.maxDepth→request.maxDepth, spec.agentOptions→request.agentOptions
 *    (omitted when the spec carries none), spec.toolFilter→request.toolFilter
 *    (omitted when unset)
 * 3. result passthrough: host {childId, messageId} returned verbatim
 * 4. failure passthrough: host rejection propagates unwrapped (same error object)
 * 5. transport validity: non spawn/fork → throw before any request
 */
import { describe, expect, it, vi } from 'vitest'
import type { DispatchSpec } from '../src/roster.ts'
import { dispatchContinuable, type ContinuableArgs, type DispatchDeps } from '../src/dispatch.ts'

/** The exact host start result a healthy mock resolves with. */
const HOST_START = { childId: 'child-abc', messageId: 'msg-123' } as const

/** A mock ctx.subagents whose startContinuable records every received spec. */
function mockSubagents(): { startContinuable: ReturnType<typeof vi.fn> } {
  return { startContinuable: vi.fn(async () => ({ ...HOST_START })) }
}

/** A DispatchSpec as roster.ts would emit it for「📚 百晓」. */
function baseSpec(overrides: Partial<DispatchSpec> = {}): DispatchSpec {
  return {
    name: '百晓',
    label: '📚 百晓',
    persona: 'You are 百晓, a scout.',
    maxDepth: 3,
    backgroundMode: 'continuable',
    fallback: 'error',
    capabilitiesNeeded: ['persona'],
    ...overrides,
  }
}

/** Valid dispatch args with a live parent object (the calling agent). */
function baseArgs(overrides: Partial<ContinuableArgs> = {}): ContinuableArgs {
  return {
    agent: { id: 'parent-1' },
    transport: 'spawn',
    spec: baseSpec(),
    prompt: '去查最新的 dsh 版本',
    ...overrides,
  }
}

/** Pull the first captured host spec off the mock, failing loudly if absent. */
function firstCall(mock: ReturnType<typeof vi.fn>): any {
  expect(mock).toHaveBeenCalledTimes(1)
  const spec = mock.mock.calls[0]?.[0]
  expect(spec).toBeDefined()
  return spec
}

describe('dispatchContinuable — parent defense (contract 1)', () => {
  it('throws mentioning parent when args.agent is undefined, without issuing a request', async () => {
    const subagents = mockSubagents()
    await expect(dispatchContinuable({ subagents }, baseArgs({ agent: undefined }))).rejects.toThrow(/parent/)
    expect(subagents.startContinuable).not.toHaveBeenCalled()
  })

  it('throws mentioning parent when args.agent is null, without issuing a request', async () => {
    const subagents = mockSubagents()
    await expect(dispatchContinuable({ subagents }, baseArgs({ agent: null }))).rejects.toThrow(/parent/)
    expect(subagents.startContinuable).not.toHaveBeenCalled()
  })
})

describe('dispatchContinuable — request construction (contract 2)', () => {
  it('builds the exact host request: transport→provider, label, ContentBlock prompt, parent, persona, maxDepth', async () => {
    const subagents = mockSubagents()
    const agent = { id: 'parent-1' }
    await dispatchContinuable({ subagents }, baseArgs({ agent }))
    const spec = firstCall(subagents.startContinuable)
    expect(spec).toEqual({
      provider: 'spawn',
      label: '📚 百晓',
      request: {
        prompt: [{ type: 'text', text: '去查最新的 dsh 版本' }],
        parent: agent,
        persona: 'You are 百晓, a scout.',
        maxDepth: 3,
      },
    })
  })

  it('passes spec.agentOptions through under request.agentOptions when the policy sets a route', async () => {
    const subagents = mockSubagents()
    const agentOptions = { provider: 'kimi', model: 'kimi-k2', maxTokens: 8192 }
    await dispatchContinuable({ subagents }, baseArgs({ spec: baseSpec({ agentOptions }) }))
    const spec = firstCall(subagents.startContinuable)
    expect(spec.request.agentOptions).toEqual(agentOptions)
  })

  it('omits request.agentOptions and request.toolFilter when the spec carries neither', async () => {
    const subagents = mockSubagents()
    await dispatchContinuable({ subagents }, baseArgs())
    const spec = firstCall(subagents.startContinuable)
    expect('agentOptions' in spec.request).toBe(false)
    expect('toolFilter' in spec.request).toBe(false)
  })

  it('passes spec.toolFilter through under request.toolFilter when the role sets a gate', async () => {
    const subagents = mockSubagents()
    const toolFilter = { deny: ['bash'] } as const
    await dispatchContinuable({ subagents }, baseArgs({ spec: baseSpec({ toolFilter }) }))
    const spec = firstCall(subagents.startContinuable)
    expect(spec.request.toolFilter).toEqual({ deny: ['bash'] })
  })

  it('maps the fork transport onto provider verbatim', async () => {
    const subagents = mockSubagents()
    await dispatchContinuable({ subagents }, baseArgs({ transport: 'fork' }))
    const spec = firstCall(subagents.startContinuable)
    expect(spec.provider).toBe('fork')
  })
})

describe('dispatchContinuable — result passthrough (contract 3)', () => {
  it('returns the host {childId, messageId} verbatim', async () => {
    const subagents = mockSubagents()
    const result = await dispatchContinuable({ subagents }, baseArgs())
    expect(result).toEqual({ childId: HOST_START.childId, messageId: HOST_START.messageId })
  })
})

describe('dispatchContinuable — failure passthrough (contract 4)', () => {
  it('propagates the host rejection unwrapped — the same error object, not a wrapper', async () => {
    const hostError = new Error('provider "fork" exploded')
    const subagents = { startContinuable: vi.fn(async () => { throw hostError }) }
    await expect(dispatchContinuable({ subagents }, baseArgs())).rejects.toBe(hostError)
  })
})

describe('dispatchContinuable — transport validity (contract 5)', () => {
  it('rejects a transport other than spawn/fork before issuing any request', async () => {
    const subagents = mockSubagents()
    const badTransport = 'teleport' as ContinuableArgs['transport']
    await expect(dispatchContinuable({ subagents }, baseArgs({ transport: badTransport }))).rejects.toThrow(/spawn/)
    expect(subagents.startContinuable).not.toHaveBeenCalled()
  })

  it('still rejects an invalid transport when the parent is valid — validation precedes the request', async () => {
    const subagents = mockSubagents()
    const badTransport = '' as ContinuableArgs['transport']
    await expect(dispatchContinuable({ subagents }, baseArgs({ transport: badTransport }))).rejects.toThrow(/spawn|fork/)
    expect(subagents.startContinuable).not.toHaveBeenCalled()
  })
})

// Live-fire regression (2026-09-11): the host service reads
// `this.requireContinuations()` internally. A destructured call
// (`const { startContinuable } = subagents; startContinuable(...)`) drops
// `this` and throws exactly this TypeError on the real host. The mock below
// is `this`-sensitive like the real service, so a destructured call fails the
// test — plain arrow mocks cannot catch this class of bug.
describe('receiver binding (live-fire regression)', () => {
  it('calls startContinuable with the host service as receiver', async () => {
    const hostLike = {
      __tag: 'host-subagents',
      startContinuable(this: { __tag?: string }, _spec: unknown) {
        if (!this || this.__tag !== 'host-subagents') {
          throw new TypeError("Cannot read properties of undefined (reading 'requireContinuations')")
        }
        return Promise.resolve({ childId: 'child-this', messageId: 'msg-this' })
      },
    }
    const result = await dispatchContinuable({ subagents: hostLike }, baseArgs())
    expect(result).toEqual({ childId: 'child-this', messageId: 'msg-this' })
  })

  it('and the destructured form really does throw (test validity check)', async () => {
    const hostLike = {
      __tag: 'host-subagents',
      startContinuable(this: { __tag?: string }, _spec: unknown) {
        if (!this || this.__tag !== 'host-subagents') {
          throw new TypeError("Cannot read properties of undefined (reading 'requireContinuations')")
        }
        return Promise.resolve({ childId: 'x', messageId: 'y' })
      },
    }
    const { startContinuable } = hostLike
    expect(() => startContinuable.call(undefined, {} as never)).toThrow(/requireContinuations/)
  })
})
