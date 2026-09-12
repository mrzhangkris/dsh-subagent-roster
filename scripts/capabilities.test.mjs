import test from 'node:test'
import assert from 'node:assert/strict'
import { installRosterCapabilities, ROSTER_USAGE_PROMPT, ROSTER_USAGE_SECTION_NAME } from '../lib/capabilities.js'

function captureCtx() {
  const sections = []
  return {
    sections,
    ctx: {
      systemPrompt: { section: definition => sections.push(definition) },
    },
  }
}

test('the roster usage policy registers one static roster-namespaced section', () => {
  const { sections, ctx } = captureCtx()
  installRosterCapabilities(ctx, { order: 117 })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, ROSTER_USAGE_SECTION_NAME)
  assert.equal(sections[0].name, 'subagent-roster:usage')
  assert.equal(sections[0].order, 117)
  assert.equal(sections[0].text(), ROSTER_USAGE_PROMPT)
})

test('the section order defaults to 117 and accepts a profile override', () => {
  const first = captureCtx()
  installRosterCapabilities(first.ctx)
  assert.equal(first.sections[0].order, 117)
  const second = captureCtx()
  installRosterCapabilities(second.ctx, { order: 200 })
  assert.equal(second.sections[0].order, 200)
})

test('the policy text is static and names both roster tools', () => {
  const { sections, ctx } = captureCtx()
  installRosterCapabilities(ctx)
  const first = sections[0].text()
  const second = sections[0].text()
  assert.equal(first, second)
  assert.ok(first.includes('roster_agent'), 'policy must name roster_agent')
  assert.ok(first.includes('roster_list'), 'policy must name roster_list')
})
