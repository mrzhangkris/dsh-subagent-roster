/** Native service dispatch plus targeted compatibility lifecycle regressions.
 * Real full-CLI/composition validation is recorded separately by the host lab.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { guardSubagentDelivery, installContinuableMemberSetup, queueMemberPrompt, sessionOwnEvents } from '../lib/harness-compat.js'

const queueKey = Symbol.for('dsh.subagent.queuePrompt')
const deliverKey = Symbol.for('dsh.subagent.deliverPrompt')
const signal = new AbortController().signal
const source = { kind: 'plugin', plugin: 'dsh-subagent-roster' }
const content = [{ type: 'text', text: 'next distinct turn' }]

function scope(extra = {}) {
  const listeners = new Map()
  const effects = []
  const ctx = {
    ...extra, listeners,
    logger: { warn() {} },
    on(name, fn) {
      const set = listeners.get(name) ?? new Set()
      listeners.set(name, set)
      set.add(fn)
      return () => set.delete(fn)
    },
    effect(setup) { const dispose = setup(); effects.push(dispose); return dispose },
    emit(name, payload) { for (const fn of [...listeners.get(name) ?? []]) fn(payload) },
    dispose() { for (const dispose of effects.splice(0).reverse()) dispose() },
  }
  return ctx
}

function modernRuntime() {
  return { [deliverKey]() {}, sendMessage() {} }
}

function child() {
  const descriptor = { type: 'subagent/descriptor', data: {
    version: 3, mode: 'continuable', provider: 'spawn', label: 'subagent-roster:role:worker',
    agentProvider: 'primary', agentModel: 'model',
  } }
  const agent = {
    id: 'member-id', status: 'idle', whenIdle: async () => {},
    session: { header: { cwd: process.cwd(), parentSession: 'captain' }, ownEvents: () => [descriptor] },
  }
  agent.ctx = scope() // Harness 0.1.5 no longer exposes Context.agent.
  return agent
}

async function selection(agent) {
  for (const assemble of agent.ctx.listeners.get('system-prompt/assemble') ?? []) {
    await assemble({}, {}, async () => ({ variables: {} }))
  }
  return requestSelection(agent)
}

async function requestSelection(agent) {
  let config = { provider: 'inherited', model: 'parent-model', reasoningEffort: 'low' }
  for (const request of agent.ctx.listeners.get('agent/request') ?? []) {
    const previous = config
    config = await request({ agent }, async () => previous)
  }
  return config
}

await test('native SubagentRuntime keeps its receiver through FIFO delivery and retirement guard', async t => {
  const host = new Context()
  const fiber = host.plugin(SubagentRuntime)
  t.after(() => fiber.dispose())
  await fiber.await()
  const runtime = host.subagents
  assert.ok(runtime)
  if (typeof runtime.registerContinuableSetup === 'function') {
    // The real implementation reads this.ctx and this.setupRegistry. Its
    // internal ctx.effect must belong to the caller plugin, not the service.
    let installed = 0
    let disposed = 0
    const caller = host.plugin({ inject: ['subagents'], apply(ctx) {
      installContinuableMemberSetup(ctx, () => { installed++; return () => { disposed++ } })
    } })
    t.after(() => caller.dispose())
    await caller.await()
    const firstChild = scope({ agent: { id: 'first' } })
    runtime.setupRegistry.apply(firstChild).commit()
    assert.deepEqual({ installed, disposed }, { installed: 1, disposed: 0 })
    await caller.dispose()
    assert.deepEqual({ installed, disposed }, { installed: 1, disposed: 1 })
    const laterChild = scope({ agent: { id: 'later' } })
    runtime.setupRegistry.apply(laterChild).commit()
    assert.equal(installed, 1)
    firstChild.dispose()
    laterChild.dispose()
    assert.equal(disposed, 1)
  }
  const accepted = []
  const manager = {
    async followup(parent, id, body, options) {
      assert.equal(this, manager)
      accepted.push({ path: 'followup', parent, id, body, source: options.source })
      return 'accepted'
    },
    async queuePrompt(parent, id, body, provenance) {
      assert.equal(this, manager)
      accepted.push({ path: 'queue', parent, id, body, source: provenance })
      return 'accepted'
    },
    async sendMessage(parent, id, body) {
      assert.equal(this, manager)
      accepted.push({ path: 'steer', parent, id, body })
      return 'steered'
    },
  }
  // Only the downstream continuation manager is replaced. The real Cordis
  // service method still executes this.requireContinuations(), unlike old fakes.
  runtime.continuations = manager
  const captain = { id: 'captain', session: { header: {} } }
  const ctx = scope({ subagents: runtime })
  const methodKey = typeof runtime.followup === 'function' ? 'followup' : typeof runtime[deliverKey] === 'function' ? deliverKey : queueKey
  const before = Object.getOwnPropertyDescriptor(runtime, methodKey)
  guardSubagentDelivery(ctx, async (_sender, id) => id === 'retired')
  assert.equal(await queueMemberPrompt(runtime, captain, 'active', content, signal), 'accepted')
  assert.deepEqual(accepted[0].source, source)
  assert.notEqual(accepted[0].path, 'steer')
  await assert.rejects(queueMemberPrompt(runtime, captain, 'retired', content, signal), { code: 'NOT_RESUMABLE' })
  if (typeof runtime.sendMessage === 'function') {
    await assert.rejects(runtime.sendMessage(captain, 'retired', content, { signal }), { code: 'NOT_RESUMABLE' })
    assert.equal(await runtime.sendMessage(captain, 'unrelated', content, { signal }), 'steered')
  }
  ctx.dispose()
  assert.deepEqual(Object.getOwnPropertyDescriptor(runtime, methodKey), before)
  assert.equal(await queueMemberPrompt(runtime, captain, 'retired', content, signal), 'accepted')
})

await test('modern queue and public messaging are both guarded, including nested HMR disposal', async () => {
  const calls = []
  const runtime = {
    [queueKey](...args) { assert.equal(this, runtime); calls.push(['queue', ...args]); return Promise.resolve('queued') },
    sendMessage(...args) { assert.equal(this, runtime); calls.push(['steer', ...args]); return Promise.resolve('steered') },
  }
  const captain = { id: 'captain' }
  const first = scope({ subagents: runtime })
  const second = scope({ subagents: runtime })
  guardSubagentDelivery(first, async (_sender, id) => id === 'retired-first')
  guardSubagentDelivery(second, async (_sender, id) => id === 'retired-second')
  await assert.rejects(queueMemberPrompt(runtime, captain, 'retired-first', content, signal), { code: 'NOT_RESUMABLE' })
  await assert.rejects(runtime.sendMessage(captain, 'retired-second', content, { signal }), { code: 'NOT_RESUMABLE' })
  first.dispose()
  assert.equal(await queueMemberPrompt(runtime, captain, 'retired-first', content, signal), 'queued')
  second.dispose()
  assert.equal(await queueMemberPrompt(runtime, captain, 'retired-second', content, signal), 'queued')
  assert.ok(calls.every(([path]) => path === 'queue'))
})

await test('unsupported queue-only or send-only contract fails explicitly', async () => {
  const runtime = { sendMessage() { assert.fail('must never substitute steer') } }
  assert.throws(() => installContinuableMemberSetup(scope({ subagents: runtime }), () => () => {}), /unsupported Harness/)
  assert.throws(() => guardSubagentDelivery(scope({ subagents: runtime }), async () => false), /unsupported Harness/)
  await assert.rejects(queueMemberPrompt(runtime, {}, 'child', content, signal), /missing host FIFO/)
  assert.throws(() => sessionOwnEvents({ header: {} }), /missing ownEvents/)
})

await test('legacy session history excludes its inherited prefix; modern uses ownEvents receiver', () => {
  const inherited = { type: 'subagent/descriptor', data: { label: 'foreign' } }
  const own = { type: 'subagent/descriptor', data: { label: 'member' } }
  assert.deepEqual(sessionOwnEvents({ header: { seedLength: 1 }, events: [inherited, own] }), [own])
  const session = { header: {}, ownEvents() { assert.equal(this, session); return [own] } }
  assert.deepEqual(sessionOwnEvents(session), [own])
})

await test('child disposal releases lifecycle contributions and permits a same-id resumed Agent', async () => {
  const ctx = scope({ subagents: modernRuntime() })
  let setups = 0
  let disposals = 0
  installContinuableMemberSetup(ctx, () => { setups++; return () => { disposals++ } })
  const first = child()
  ctx.emit('agent/session-start', { agent: first })
  first.ctx.dispose()
  assert.equal(disposals, 1)
  const second = child()
  ctx.emit('agent/session-start', { agent: second, source: 'resume' })
  assert.equal(setups, 2)
  ctx.dispose()
  assert.equal(disposals, 2)
  second.ctx.dispose()
  assert.equal(disposals, 2)
})

await test('setup exception blocks request instead of being swallowed by session-start dispatch', async () => {
  const ctx = scope({ subagents: modernRuntime() })
  installContinuableMemberSetup(ctx, () => { throw new Error('damaged durable model route') })
  const agent = child()
  ctx.emit('agent/session-start', { agent })
  await assert.rejects(selection(agent), /member initialization failed.*damaged durable model route/)
  ctx.dispose()
  assert.equal(agent.ctx.listeners.get('agent/request').size, 0)
})

await test('0.1.5 delivery queues job prompts and guards both host modes across HMR', async () => {
  const calls = []
  const runtime = {
    [deliverKey](...args) { assert.equal(this, runtime); calls.push(args); return Promise.resolve('accepted') },
    sendMessage(...args) { assert.equal(this, runtime); return Promise.resolve('steered') },
  }
  const original = Object.getOwnPropertyDescriptor(runtime, deliverKey)
  const captain = { id: 'captain' }
  const first = scope({ subagents: runtime }), second = scope({ subagents: runtime })
  guardSubagentDelivery(first, async (_sender, id) => id === 'retired-first')
  guardSubagentDelivery(second, async (_sender, id) => id === 'retired-second')
  assert.equal(await queueMemberPrompt(runtime, captain, 'active', content, signal), 'accepted')
  assert.deepEqual(calls[0], [captain, 'active', content, source, signal, 'queue'])
  for (const id of ['retired-first', 'retired-second']) {
    for (const mode of ['queue', 'steer']) {
      await assert.rejects(runtime[deliverKey](captain, id, content, source, signal, mode), { code: 'NOT_RESUMABLE' })
    }
    await assert.rejects(runtime.sendMessage(captain, id, content, { signal }), { code: 'NOT_RESUMABLE' })
  }
  first.dispose()
  assert.equal(await queueMemberPrompt(runtime, captain, 'retired-first', content, signal), 'accepted')
  await assert.rejects(queueMemberPrompt(runtime, captain, 'retired-second', content, signal), { code: 'NOT_RESUMABLE' })
  second.dispose()
  assert.equal(await runtime[deliverKey](captain, 'retired-second', content, source, signal, 'steer'), 'accepted')
  assert.equal(calls.at(-1).at(-1), 'steer')
  // The surviving wrapper of an already disposed parent becomes inert.
  const clean = scope({ subagents: runtime })
  guardSubagentDelivery(clean, async () => true)
  clean.dispose()
  assert.equal(await queueMemberPrompt(runtime, captain, 'active', content, signal), 'accepted')
  assert.equal(typeof original.value, 'function')
})
