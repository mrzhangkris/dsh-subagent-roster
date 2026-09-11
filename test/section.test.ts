/**
 * Dynamic roster prompt-section contract tests (Task 8, part A).
 *
 * These specify `src/section.ts`: `buildRosterSection` turns a validated
 * `RosterConfig` into the model-facing roster directory section. The behavior
 * matrix (brief part A — three states):
 * 1. An EMPTY roster (no agents, or every agent disabled) → `null` — the
 *    section is never registered with content.
 * 2. Enabled rows carry icon (optional) + name + description + the model
 *    policy badge (inherit→「继承主模型」、fixed→「固定 <model>」、auto→「auto」)
 *    and the background mode, framed by the fixed header/footer lines.
 * 3. Disabled roles never appear in the text.
 */
import { describe, expect, it } from 'vitest'
import { normalizeAgent, type RosterAgent, type RosterConfig } from '../src/schema.ts'
import { buildRosterSection, modelPolicyBadge } from '../src/section.ts'

/** A defaults-filled agent as `readRoster` would store it. */
function agent(overrides: Partial<RosterAgent> = {}): RosterAgent {
  return normalizeAgent({
    name: '百晓',
    description: '博闻强记的资料检索与调研助手',
    persona: 'You are 百晓.',
    icon: '📚',
    ...overrides,
  })
}

/** A roster config holding exactly the given agents. */
function roster(agents: RosterAgent[]): RosterConfig {
  return { schemaVersion: 1, transport: 'spawn', agents, autoChain: [] }
}

describe('buildRosterSection — three states', () => {
  it('returns null for an empty roster (section is never registered)', () => {
    expect(buildRosterSection(roster([]))).toBeNull()
  })

  it('returns null when every agent is disabled', () => {
    const section = buildRosterSection(roster([agent({ enabled: false }), agent({ name: '风清', enabled: false })]))
    expect(section).toBeNull()
  })

  it('renders one enabled role with icon/name/description and model+background badges', () => {
    const section = buildRosterSection(roster([agent()]))
    expect(section).not.toBeNull()
    if (section === null) throw new Error('expected a section for an enabled roster')
    expect(section.name).toBe('subagent-roster:roster')
    expect(section.text).toContain('当前花名册角色（设置→插件→子智能体花名册可维护）：')
    expect(section.text).toContain('- 📚 百晓——博闻强记的资料检索与调研助手（模型: 继承主模型/后台: continuable）')
    expect(section.text).toContain('派具名角色用 roster_agent 工具；临时任务用官方 subagent；不确定派谁先调 roster_list。')
  })

  it('excludes disabled roles while keeping enabled ones', () => {
    const section = buildRosterSection(roster([
      agent({ enabled: false }),
      agent({ name: '墨算', icon: undefined, description: '数据分析与建模' }),
    ]))
    if (section === null) throw new Error('expected a section with one enabled role')
    expect(section.text).not.toContain('百晓')
    expect(section.text).toContain('- 墨算——数据分析与建模')
  })

  it('lists every enabled role in roster order', () => {
    const section = buildRosterSection(roster([
      agent({ icon: '📚' }),
      agent({ name: '风清', icon: '🖋️', description: '文案润色' }),
    ]))
    if (section === null) throw new Error('expected a section')
    const first = section.text.indexOf('📚 百晓')
    const second = section.text.indexOf('🖋️ 风清')
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
  })
})

describe('buildRosterSection — model policy badges', () => {
  it('inherit renders 继承主模型, fixed renders 固定 <model>, auto renders auto', () => {
    const section = buildRosterSection(roster([
      agent({ name: '继承者', icon: undefined }),
      agent({ name: '固定者', icon: undefined, modelPolicy: 'fixed', provider: 'openai', model: 'gpt-x' }),
      agent({ name: '自动者', icon: undefined, modelPolicy: 'auto' }),
    ]))
    if (section === null) throw new Error('expected a section')
    expect(section.text).toContain('- 继承者——博闻强记的资料检索与调研助手（模型: 继承主模型/后台: continuable）')
    expect(section.text).toContain('- 固定者——博闻强记的资料检索与调研助手（模型: 固定 gpt-x/后台: continuable）')
    expect(section.text).toContain('- 自动者——博闻强记的资料检索与调研助手（模型: auto/后台: continuable）')
  })

  it('degrades to the bare name when the icon is absent or empty', () => {
    const section = buildRosterSection(roster([agent({ icon: undefined }), agent({ name: '空图', icon: '' })]))
    if (section === null) throw new Error('expected a section')
    expect(section.text).toContain('- 百晓——')
    expect(section.text).toContain('- 空图——')
    expect(section.text).not.toContain('-  —') // no dangling empty icon slot
  })
})

describe('modelPolicyBadge — shared badge vocabulary', () => {
  it('maps the three policies to their display badges', () => {
    expect(modelPolicyBadge({ modelPolicy: 'inherit' })).toBe('继承主模型')
    expect(modelPolicyBadge({ modelPolicy: 'fixed', model: 'glm-5' })).toBe('固定 glm-5')
    expect(modelPolicyBadge({ modelPolicy: 'auto' })).toBe('auto')
  })
})
