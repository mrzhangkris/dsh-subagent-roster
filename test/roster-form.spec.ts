/**
 * Roster settings-card form logic (Task 9).
 *
 * The card's DOM half is verified on a mounted host (no jsdom harness in this
 * repo); everything the browser must NOT get wrong lives in
 * `src/client/roster-form.ts` as pure functions and is pinned here:
 * draft ⇄ agent assembly (including the adapter-owned `reasoningEffort`
 * passthrough), same-source validation via `validateRoster` with field-path
 * mapping, the rename confirmation predicate, all-or-nothing import with the
 * newer-schema refusal, the stable export text, and the immutable whole-roster
 * edit helpers the row toggle and the autoChain editor go through.
 */
import { describe, expect, it } from 'vitest'
import { validateRoster, type RosterConfig, type RosterAgent } from '../src/schema.ts'
import {
  CONFLICT_MESSAGE,
  IMPORT_VERSION_MESSAGE,
  TOOL_FILTER_SUGGESTION,
  agentFromDraft,
  draftFromAgent,
  emptyDraft,
  exportRosterText,
  importRosterText,
  nameConflict,
  needsRenameConfirm,
  rosterWithAutoChain,
  rosterWithToggledEnabled,
  validateDraft,
  type RosterDraft,
} from '../src/client/roster-form.ts'

const BASE_ROSTER: RosterConfig = {
  schemaVersion: 1,
  transport: 'spawn',
  agents: [],
  autoChain: [],
}

const SCOUT: RosterAgent = {
  name: 'scout',
  description: 'A fast scout',
  persona: 'You are a scout.',
  modelPolicy: 'inherit',
  maxDepth: 3,
  backgroundMode: 'continuable',
  fallback: 'error',
  enabled: true,
}

function rosterWith(...agents: RosterAgent[]): RosterConfig {
  return { ...BASE_ROSTER, agents }
}

describe('agentFromDraft — assembly and defaults', () => {
  it('trims the name and fills the documented defaults on an empty draft', () => {
    const draft = { ...emptyDraft(), name: '  scout  ', description: 'A fast scout', persona: 'p' }
    const agent = agentFromDraft(draft)
    expect(agent.name).toBe('scout')
    expect(agent.modelPolicy).toBe('inherit')
    expect(agent.maxDepth).toBe(3)
    expect(agent.backgroundMode).toBe('continuable')
    expect(agent.fallback).toBe('error')
    expect(agent.enabled).toBe(true)
    expect('reasoningEffort' in agent).toBe(false)
    expect('maxTokens' in agent).toBe(false)
    expect('toolFilter' in agent).toBe(false)
    expect('icon' in agent).toBe(false)
  })

  it('passes reasoningEffort through VERBATIM (adapter-owned raw string, not an enum)', () => {
    const draft: RosterDraft = { ...emptyDraft(), reasoningEffort: '  High-Medium (custom) ' }
    expect(agentFromDraft(draft).reasoningEffort).toBe('  High-Medium (custom) ')
  })

  it('carries provider+model only under the fixed policy, and fallback under auto', () => {
    const fixed = agentFromDraft({
      ...emptyDraft(),
      modelPolicy: 'fixed',
      provider: ' kimi ',
      model: ' kimi-for-coding ',
    })
    expect(fixed.modelPolicy).toBe('fixed')
    expect(fixed.provider).toBe('kimi')
    expect(fixed.model).toBe('kimi-for-coding')

    const inherit = agentFromDraft({ ...emptyDraft(), provider: 'x', model: 'y' })
    expect('provider' in inherit).toBe(false)
    expect('model' in inherit).toBe(false)

    const auto = agentFromDraft({ ...emptyDraft(), modelPolicy: 'auto', fallback: 'inherit' })
    expect(auto.modelPolicy).toBe('auto')
    expect(auto.fallback).toBe('inherit')
  })

  it('parses maxTokens when typed and omits it when left empty', () => {
    expect(agentFromDraft({ ...emptyDraft(), maxTokens: ' 4096 ' }).maxTokens).toBe(4096)
    expect('maxTokens' in agentFromDraft({ ...emptyDraft(), maxTokens: '' })).toBe(false)
  })

  it('splits the comma-separated toolFilter input and keeps tri-state exactness', () => {
    const deny = agentFromDraft({ ...emptyDraft(), toolFilterMode: 'deny', toolFilterInput: ' bash, web_search ,, read ' })
    expect(deny.toolFilter).toEqual({ deny: ['bash', 'web_search', 'read'] })
    const allow = agentFromDraft({ ...emptyDraft(), toolFilterMode: 'allow', toolFilterInput: 'read' })
    expect(allow.toolFilter).toEqual({ allow: ['read'] })
    // none → the field stays absent (no empty deny/allow object is written).
    expect('toolFilter' in agentFromDraft({ ...emptyDraft(), toolFilterInput: 'bash' })).toBe(false)
  })

  it('parses maxDepth and keeps it a positive integer', () => {
    expect(agentFromDraft({ ...emptyDraft(), maxDepth: '5' }).maxDepth).toBe(5)
  })

  it('round-trips: draftFromAgent → agentFromDraft preserves a normalized agent', () => {
    const agent: RosterAgent = {
      ...SCOUT,
      icon: '🔍',
      modelPolicy: 'fixed',
      provider: 'kimi',
      model: 'kimi-for-coding',
      reasoningEffort: 'high',
      maxTokens: 8192,
      toolFilter: { deny: ['bash'] },
      maxDepth: 2,
      backgroundMode: 'one-shot',
      fallback: 'inherit',
      enabled: false,
    }
    expect(agentFromDraft(draftFromAgent(agent))).toEqual(agent)
  })
})

describe('validateDraft — same-source validation with field mapping', () => {
  it('accepts a clean draft with no field errors', () => {
    const draft = { ...emptyDraft(), name: 'scout', description: 'd', persona: 'p' }
    expect(validateDraft(draft, BASE_ROSTER, null).ok).toBe(true)
  })

  it('flags an immediate duplicate name against another agent, on the name field', () => {
    const draft = { ...emptyDraft(), name: ' scout ', description: 'd', persona: 'p' }
    const result = validateDraft(draft, rosterWith(SCOUT), null)
    expect(result.ok).toBe(false)
    expect(result.fieldErrors.name).toBeTruthy()
  })

  it('never flags the edited agent against itself', () => {
    const draft = draftFromAgent(SCOUT)
    expect(validateDraft(draft, rosterWith(SCOUT), 0).ok).toBe(true)
    expect(nameConflict('scout', rosterWith(SCOUT), 0)).toBe(false)
  })

  it('maps description/persona length errors to their fields via the validator', () => {
    const draft = {
      ...emptyDraft(),
      name: 'a',
      description: 'x'.repeat(101),
      persona: 'y'.repeat(20_001),
    }
    const result = validateDraft(draft, BASE_ROSTER, null)
    expect(result.ok).toBe(false)
    expect(result.fieldErrors.description).toBeTruthy()
    expect(result.fieldErrors.persona).toBeTruthy()
  })

  it('requires provider+model when the fixed policy is chosen', () => {
    const draft = { ...emptyDraft(), name: 'a', description: 'd', persona: 'p', modelPolicy: 'fixed' as const }
    const result = validateDraft(draft, BASE_ROSTER, null)
    expect(result.fieldErrors.provider).toBeTruthy()
    expect(result.fieldErrors.model).toBeTruthy()
  })

  it('rejects an empty deny/allow list and a non-positive maxDepth in place', () => {
    const emptyList = validateDraft(
      { ...emptyDraft(), name: 'a', description: 'd', persona: 'p', toolFilterMode: 'deny', toolFilterInput: ' , ,' },
      BASE_ROSTER, null,
    )
    expect(emptyList.fieldErrors.toolFilter).toBeTruthy()

    const badDepth = validateDraft(
      { ...emptyDraft(), name: 'a', description: 'd', persona: 'p', maxDepth: '0' },
      BASE_ROSTER, null,
    )
    expect(badDepth.fieldErrors.maxDepth).toBeTruthy()
  })

  it('surfaces roster-level issues (the 50-agent cap) outside the field map', () => {
    const full = rosterWith(...Array.from({ length: 50 }, (_, i) => ({ ...SCOUT, name: `role-${i}`, description: 'd' })))
    const result = validateDraft({ ...emptyDraft(), name: 'overflow', description: 'd', persona: 'p' }, full, null)
    expect(result.ok).toBe(false)
    expect(result.fieldErrors.name).toBeUndefined()
    expect(result.otherErrors.some((issue) => issue.path === 'agents' && issue.msg.includes('capped'))).toBe(true)
  })
})

describe('needsRenameConfirm — the rename gate', () => {
  it('fires only when editing an existing agent whose name actually changed', () => {
    expect(needsRenameConfirm(true, 'old', 'new')).toBe(true)
    expect(needsRenameConfirm(true, 'same', 'same')).toBe(false)
    expect(needsRenameConfirm(true, ' same ', 'same')).toBe(false)
    expect(needsRenameConfirm(false, 'old', 'new')).toBe(false)
  })
})

describe('importRosterText — all-or-nothing with the newer-schema refusal', () => {
  it('accepts a full export and reports the replaced count', () => {
    const text = exportRosterText(rosterWith(SCOUT, { ...SCOUT, name: 'writer', description: 'w' }))
    const outcome = importRosterText(text)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.replaced).toBe(2)
    expect(outcome.roster.agents.map((agent) => agent.name)).toEqual(['scout', 'writer'])
    // Normalization ran: defaults are filled for the whole config.
    expect(outcome.roster.agents[1]?.maxDepth).toBe(3)
  })

  it('refuses schemaVersion > 1 with the read-only upgrade message (never writes)', () => {
    const text = JSON.stringify({ schemaVersion: 2, transport: 'spawn', agents: [], autoChain: [] })
    const outcome = importRosterText(text)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('version')
    expect(outcome.message).toBe(IMPORT_VERSION_MESSAGE)
    expect(IMPORT_VERSION_MESSAGE).toBe('文件版本高于当前支持（只读兼容），请升级插件')
  })

  it('rejects one bad agent out of many — no partial roster, per-field located errors', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      transport: 'spawn',
      agents: [
        { name: 'good', description: 'g', persona: 'p' },
        { name: '', description: 'd'.repeat(101), persona: '' },
      ],
      autoChain: [],
    })
    const outcome = importRosterText(text)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('invalid')
    const paths = outcome.issues.map((issue) => issue.path)
    expect(paths).toContain('agents[1].name')
    expect(paths).toContain('agents[1].description')
    expect(paths).toContain('agents[1].persona')
    expect('roster' in outcome).toBe(false)
  })

  it('maps broken JSON and non-object documents to parse errors', () => {
    const broken = importRosterText('{ schemaVersion: 1,')
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.kind).toBe('parse')

    const array = importRosterText('[]')
    expect(array.ok).toBe(false)
    if (!array.ok) expect(array.kind).toBe('invalid')
  })
})

describe('exportRosterText — stable download text', () => {
  it('round-trips through JSON.parse byte-stably (pretty, trailing newline)', () => {
    const roster = rosterWith(SCOUT)
    const text = exportRosterText(roster)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "agents": [')
    expect(JSON.parse(text)).toEqual(roster)
    expect(exportRosterText(roster)).toBe(text)
  })
})

describe('rosterWithToggledEnabled / rosterWithAutoChain — immutable whole-roster edits', () => {
  it('flips exactly one agent and mutates nothing in place', () => {
    const roster = rosterWith(SCOUT, { ...SCOUT, name: 'writer', description: 'w' })
    const next = rosterWithToggledEnabled(roster, 1)
    expect(next.agents[1]?.enabled).toBe(false)
    expect(next.agents[0]?.enabled).toBe(true)
    expect(roster.agents[1]?.enabled).toBe(true)
    expect(validateRoster(next).ok).toBe(true)
  })

  it('replaces the autoChain wholesale and stays valid', () => {
    const next = rosterWithAutoChain(BASE_ROSTER, [
      { provider: 'deepseek', model: 'deepseek-chat' },
      { provider: 'kimi', model: 'kimi-for-coding' },
    ])
    expect(next.autoChain).toHaveLength(2)
    expect(next.transport).toBe('spawn')
    expect(validateRoster(next).ok).toBe(true)
  })

  it('keeps the conflict and toolFilter copy at their contractual wording', () => {
    expect(CONFLICT_MESSAGE).toBe('名单已被其他窗口修改，请刷新后重做（本次改动将丢弃）')
    expect(TOOL_FILTER_SUGGESTION).toBe('供成员派单的角色建议配置 toolFilter 收窄工具面')
  })
})
