/**
 * One-shot foreground/background settlement contract tests (Task 6).
 *
 * These specify the two `dispatch.ts` additions that mirror the official
 * tool-subagent one-shot paths (`settleForegroundRun` / `settleStart` +
 * `jobs.start`):
 *
 * Foreground (`dispatchOneShotForeground`):
 * 1. start request construction is isomorphic with Task 5's continuable link
 *    (provider/label/persona/agentOptions/toolFilter/maxDepth/ContentBlock
 *    prompt/transport validation/parent defense)
 * 2. result+dispose allSettled pairing: both settle → ok; dispose rejects
 *    while the result succeeds → the result is not swallowed (dispose error
 *    surfaces in the failure detail tail); result and dispose both fail →
 *    aggregate failure mentioning both
 * 3. stopReason mapping: `completed` → ok + final text; every other reason
 *    (cancelled/aborted/error/max-tokens/refusal/host additions) → ok:false
 *    with a headline carrying the reason; an unknown or MISSING stopReason
 *    falls back to failure with "unknown stop reason" semantics
 * 4. partial text: a non-completed result preserving assistant text appends
 *    the official 「Partial output before the run ended:」 block to the detail
 * 5. provider diagnostic: a result carrying `diagnostic` appends it
 *
 * Background (`dispatchOneShotBackground`):
 * 6. registers a jobs task with `kind: 'subagent'`, `owner: parent`, a label,
 *    preserving the terminal reason and diagnostics in the outcome
 * 7. task-owned AbortController: the controller is created inside the task
 *    `run`, its signal (never args.signal itself) goes to start, and
 *    args.signal aborts are forwarded to the controller
 * 8. abort mapping: `signal.aborted && !(error instanceof AggregateError)`
 *    → the task settles `killed` (official settleStart semantics)
 */
import { describe, expect, it, vi } from 'vitest'
import type { DispatchSpec } from '../src/roster.ts'
import {
  dispatchOneShotBackground,
  dispatchOneShotForeground,
  type OneShotArgs,
  type OneShotDeps,
} from '../src/dispatch.ts'

/** A DispatchSpec as roster.ts would emit it for「📚 百晓」. */
function baseSpec(overrides: Partial<DispatchSpec> = {}): DispatchSpec {
  return {
    name: '百晓',
    label: '📚 百晓',
    persona: 'You are 百晓, a scout.',
    maxDepth: 3,
    backgroundMode: 'oneshot',
    fallback: 'error',
    capabilitiesNeeded: ['persona'],
    ...overrides,
  }
}

/** Valid one-shot args with a live parent object (the calling agent). */
function baseArgs(overrides: Partial<OneShotArgs> = {}): OneShotArgs {
  return {
    agent: { id: 'parent-1' },
    transport: 'spawn',
    spec: baseSpec(),
    prompt: '去查最新的 dsh 版本',
    ...overrides,
  }
}

/** A completed result carrying the given output blocks. */
function completedResult(output: { type: 'text'; text: string }[] = [{ type: 'text', text: '答案在这' }]) {
  return { output, stopReason: 'completed' }
}

/** A controllable fake SubagentRun: result/dispose promises we settle by hand. */
function fakeRun(overrides: {
  result?: Promise<any>
  dispose?: () => Promise<void> | void
} = {}) {
  return {
    id: 'run-1',
    result: overrides.result ?? Promise.resolve(completedResult()),
    dispose: overrides.dispose ?? vi.fn(async () => {}),
  }
}

/** A mock ctx.subagents.start recording requests and returning a fake run. */
function mockSubagents(run = fakeRun()) {
  return { start: vi.fn(async () => run) }
}

/** A mock jobs service whose start records the whole registration. */
function mockJobs() {
  const registrations: any[] = []
  return {
    registrations,
    start: vi.fn((spec: any) => {
      registrations.push(spec)
      return 'job-77'
    }),
  }
}

/** First captured argument of a mock fn, failing loudly when absent. */
function firstCall(mock: ReturnType<typeof vi.fn>): any {
  const call = mock.mock.calls[0]
  if (call === undefined) throw new Error('mock was never called')
  return call[0]
}

describe('dispatchOneShotForeground — request construction (contract 1)', () => {
  it('builds the nested start request exactly like the continuable link', async () => {
    const subagents = mockSubagents()
    await dispatchOneShotForeground(
      { subagents } as unknown as OneShotDeps,
      baseArgs({ prompt: 'hello world', transport: 'fork' }),
    )
    const spec = firstCall(subagents.start)
    expect(spec).toEqual({
      provider: 'fork',
      label: '📚 百晓',
      request: {
        prompt: [{ type: 'text', text: 'hello world' }],
        parent: { id: 'parent-1' },
        persona: 'You are 百晓, a scout.',
        maxDepth: 3,
      },
    })
  })

  it('passes agentOptions/toolFilter only when the spec carries them', async () => {
    const subagents = mockSubagents()
    await dispatchOneShotForeground(
      { subagents } as unknown as OneShotDeps,
      baseArgs({ spec: baseSpec({ agentOptions: { model: 'm1' } as any, toolFilter: ['read'] }) }),
    )
    const spec = firstCall(subagents.start)
    expect(spec.request.agentOptions).toEqual({ model: 'm1' })
    expect(spec.request.toolFilter).toEqual(['read'])

    const subagents2 = mockSubagents()
    await dispatchOneShotForeground({ subagents: subagents2 } as unknown as OneShotDeps, baseArgs())
    expect('agentOptions' in firstCall(subagents2.start).request).toBe(false)
    expect('toolFilter' in firstCall(subagents2.start).request).toBe(false)
  })

  it('throws on a missing parent before issuing any request', async () => {
    const subagents = mockSubagents()
    await expect(
      dispatchOneShotForeground(
        { subagents } as unknown as OneShotDeps,
        baseArgs({ agent: undefined }),
      ),
    ).rejects.toThrow(/parent/)
    expect(subagents.start).not.toHaveBeenCalled()
  })

  it('throws on an invalid transport before issuing any request', async () => {
    const subagents = mockSubagents()
    await expect(
      dispatchOneShotForeground(
        { subagents } as unknown as OneShotDeps,
        baseArgs({ transport: 'teleport' as any }),
      ),
    ).rejects.toThrow(/transport/)
    expect(subagents.start).not.toHaveBeenCalled()
  })

  it('forwards the host exec signal to start when provided', async () => {
    const subagents = mockSubagents()
    const controller = new AbortController()
    await dispatchOneShotForeground(
      { subagents } as unknown as OneShotDeps,
      baseArgs({ signal: controller.signal }),
    )
    expect(firstCall(subagents.start).signal).toBe(controller.signal)
  })
})

describe('dispatchOneShotForeground — result/dispose pairing (contract 2)', () => {
  it('returns ok with the flattened final text when both settle cleanly', async () => {
    const run = fakeRun({ result: Promise.resolve(completedResult([
      { type: 'text', text: 'alpha ' },
      { type: 'text', text: 'beta' },
    ])) })
    const out = await dispatchOneShotForeground(
      { subagents: mockSubagents(run) } as unknown as OneShotDeps,
      baseArgs(),
    )
    expect(out).toEqual({ ok: true, text: 'alpha beta' })
    expect(run.dispose).toHaveBeenCalledOnce()
  })

  it('does not swallow the result when dispose fails after a good run', async () => {
    const run = fakeRun({ dispose: vi.fn(async () => { throw new Error('dispose boom') }) })
    const out = await dispatchOneShotForeground(
      { subagents: mockSubagents(run) } as unknown as OneShotDeps,
      baseArgs(),
    )
    // The result is not swallowed: ok stays true, the text survives, and the
    // dispose error rides the detail tail.
    expect(out.ok).toBe(true)
    expect((out as { text: string }).text).toBe('答案在这')
    expect((out as { detail?: string }).detail).toContain('dispose boom')
  })

  it('aggregates both failures when result and dispose both reject', async () => {
    const run = fakeRun({
      result: Promise.reject(new Error('result boom')),
      dispose: vi.fn(async () => { throw new Error('dispose boom') }),
    })
    const out = await dispatchOneShotForeground(
      { subagents: mockSubagents(run) } as unknown as OneShotDeps,
      baseArgs(),
    )
    expect(out.ok).toBe(false)
    const joined = `${(out as any).errorTitle} ${(out as any).detail}`
    expect(joined).toContain('result boom')
    expect(joined).toContain('dispose boom')
  })
})

describe('dispatchOneShotForeground — stopReason mapping (contract 3)', () => {
  it('maps known non-completed reasons to failures carrying the reason', async () => {
    for (const [reason, needle] of [
      ['aborted', 'cancelled'],
      ['error', 'failed'],
      ['max-tokens', 'token limit'],
      ['refusal', 'declined'],
    ] as const) {
      const run = fakeRun({ result: Promise.resolve({ output: [], stopReason: reason }) })
      const out = await dispatchOneShotForeground(
        { subagents: mockSubagents(run) } as unknown as OneShotDeps,
        baseArgs(),
      )
      expect(out.ok, `reason ${reason}`).toBe(false)
      expect((out as any).errorTitle, `reason ${reason}`).toContain(needle)
    }
  })

  it('falls back to failure with unknown-stop-reason semantics for host additions', async () => {
    const run = fakeRun({ result: Promise.resolve({ output: [], stopReason: 'time-travel' }) })
    const out = await dispatchOneShotForeground(
      { subagents: mockSubagents(run) } as unknown as OneShotDeps,
      baseArgs(),
    )
    expect(out.ok).toBe(false)
    expect((out as any).errorTitle).toContain('unknown stop reason')
    expect((out as any).errorTitle).toContain('time-travel')
  })

  it('treats a MISSING stopReason as an unknown-reason failure, not success', async () => {
    const run = fakeRun({ result: Promise.resolve({ output: [{ type: 'text', text: '看起来像成功' }] }) })
    const out = await dispatchOneShotForeground(
      { subagents: mockSubagents(run) } as unknown as OneShotDeps,
      baseArgs(),
    )
    expect(out.ok).toBe(false)
    expect((out as any).errorTitle).toContain('unknown stop reason')
  })
})

describe('dispatchOneShotForeground — partial text + diagnostics (contracts 4-5)', () => {
  it('appends the official partial-output block for a non-completed run with text', async () => {
    const run = fakeRun({ result: Promise.resolve({
      output: [{ type: 'text', text: '写了一半的回答' }],
      stopReason: 'max-tokens',
    }) })
    const out = await dispatchOneShotForeground(
      { subagents: mockSubagents(run) } as unknown as OneShotDeps,
      baseArgs(),
    )
    expect(out.ok).toBe(false)
    expect((out as any).detail).toContain('Partial output before the run ended:')
    expect((out as any).detail).toContain('写了一半的回答')
  })

  it('appends the provider diagnostic when the run carries one', async () => {
    const run = fakeRun({ result: Promise.resolve({
      output: [],
      stopReason: 'error',
      diagnostic: 'provider said: upstream 500',
    }) })
    const out = await dispatchOneShotForeground(
      { subagents: mockSubagents(run) } as unknown as OneShotDeps,
      baseArgs(),
    )
    expect(out.ok).toBe(false)
    expect((out as any).detail).toContain('provider said: upstream 500')
  })
})

describe('dispatchOneShotBackground — jobs registration (contract 6)', () => {
  it('registers a subagent-kind task owned by the parent and returns the job id', () => {
    const jobs = mockJobs()
    const args = baseArgs()
    const out = dispatchOneShotBackground(
      { subagents: mockSubagents(), jobs } as unknown as OneShotDeps,
      args,
    )
    expect(out).toEqual({ jobId: 'job-77' })
    const reg = firstCall(jobs.start)
    expect(reg.kind).toBe('subagent')
    expect(reg.owner).toBe(args.agent)
    expect(reg.label).toBe('📚 百晓')
    expect(typeof reg.run).toBe('function')
  })

  it('throws a naming error when the jobs service is unavailable', () => {
    expect(() =>
      dispatchOneShotBackground(
        { subagents: mockSubagents() } as unknown as OneShotDeps,
        baseArgs(),
      ),
    ).toThrow(/jobs/)
  })

  it('propagates a failed provider result into a failed outcome with the stop reason', async () => {
    const run = fakeRun({ result: Promise.resolve({
      output: [],
      stopReason: 'refusal',
      diagnostic: 'policy',
    }) })
    const jobs = mockJobs()
    dispatchOneShotBackground(
      { subagents: mockSubagents(run), jobs } as unknown as OneShotDeps,
      baseArgs(),
    )
    const outcome = await firstCall(jobs.start).run().done
    expect(outcome).toEqual({ status: 'failed', detail: expect.stringContaining('refusal') })
    expect(outcome.detail).toContain('policy')
  })
})

describe('dispatchOneShotBackground — task-owned AbortController (contract 7)', () => {
  it('hands the controller signal (not args.signal) to start and forwards aborts', async () => {
    const captured: AbortSignal[] = []
    const subagents = {
      start: vi.fn((spec: any) => {
        captured.push(spec.signal)
        // Simulate a provider whose STARTUP rejects when its signal aborts.
        const signal = spec.signal as AbortSignal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('provider aborted mid-start')) }, { once: true })
        })
      }),
    }
    const jobs = mockJobs()
    const host = new AbortController()
    dispatchOneShotBackground(
      { subagents, jobs } as unknown as OneShotDeps,
      baseArgs({ signal: host.signal }),
    )
    const task = firstCall(jobs.start).run()
    expect(captured[0]).toBeDefined()
    expect(captured[0]).not.toBe(host.signal)
    expect(captured[0]!.aborted).toBe(false)

    host.abort('host killed the tool call')
    expect(captured[0]!.aborted).toBe(true)
    expect(captured[0]!.reason).toBe('host killed the tool call')
    // The forwarded abort settles the task as killed (provider startup failed
    // on a plain abort — not an AggregateError).
    await expect(task.done).resolves.toEqual({ status: 'killed' })

    // The task's own cancel path also aborts through the same controller.
    task.cancel('task cancel')
  })
})

describe('dispatchOneShotBackground — abort mapping (contract 8)', () => {
  it('maps an aborted startup to a killed task, unless it is an AggregateError', async () => {
    const jobs = mockJobs()
    // Startup rejects because the signal aborted mid-start.
    const subagents = {
      start: vi.fn((spec: any) => {
        const signal = spec.signal as AbortSignal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('startup aborted')) }, { once: true })
        })
      }),
    }
    dispatchOneShotBackground(
      { subagents, jobs } as unknown as OneShotDeps,
      baseArgs(),
    )
    const task = firstCall(jobs.start).run()
    task.cancel()
    await expect(task.done).resolves.toEqual({ status: 'killed' })
  })

  it('does not turn an AggregateError startup failure into a clean kill', async () => {
    const jobs = mockJobs()
    const subagents = {
      start: vi.fn(async () => {
        throw new AggregateError([new Error('spawn failed'), new Error('rollback failed')])
      }),
    }
    dispatchOneShotBackground(
      { subagents, jobs } as unknown as OneShotDeps,
      baseArgs(),
    )
    const task = firstCall(jobs.start).run()
    task.cancel()
    const outcome = await task.done
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('rollback failed')
  })

  it('keeps the parent/transport defenses in the background path too', () => {
    const jobs = mockJobs()
    const subagents = mockSubagents()
    expect(() =>
      dispatchOneShotBackground(
        { subagents, jobs } as unknown as OneShotDeps,
        baseArgs({ agent: undefined }),
      ),
    ).toThrow(/parent/)
    expect(() =>
      dispatchOneShotBackground(
        { subagents, jobs } as unknown as OneShotDeps,
        baseArgs({ transport: 'nope' as any }),
      ),
    ).toThrow(/transport/)
    expect(jobs.start).not.toHaveBeenCalled()
  })
})
