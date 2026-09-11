/**
 * Roster settings-card form logic (Task 9) — the pure half of the card.
 *
 * Every decision the browser must not get wrong is a plain function here, so
 * `test/roster-form.spec.ts` can pin it without a DOM harness:
 *
 * - `RosterDraft` mirrors what the inputs hold (strings everywhere), and
 *   `agentFromDraft` / `draftFromAgent` convert between the draft and the
 *   `RosterAgent` contract from `../schema.ts` — the SAME source the host
 *   validates with. `reasoningEffort` is adapter-owned and passes through
 *   VERBATIM (a text input, never an enum), mirroring the schema layer's
 *   no-validation ruling.
 * - `validateDraft` reuses `validateRoster` on the assembled whole-roster
 *   candidate (replace-at-index or append), then maps the validator's indexed
 *   paths (`agents[2].name`) back onto form fields so errors render in place.
 * - `importRosterText` is all-or-nothing: the whole document must read back
 *   through the shared `readRoster` pipeline before anything is returned; a
 *   newer `schemaVersion` refuses with the read-only upgrade message.
 * - `rosterWithToggledEnabled` / `rosterWithAutoChain` are the immutable
 *   whole-array edits the wire write goes through (the namespace section
 *   stores `agents` and `autoChain` as single fields, so any edit rewrites
 *   the whole array in one fenced operation).
 *
 * @module dsh-subagent-roster/client/roster-form
 */

import { readRoster } from '../roster-read.ts'
import {
  validateRoster,
  type RosterAgent,
  type RosterAutoChainRoute,
  type RosterConfig,
  type RosterIssue,
} from '../schema.ts'

/** Save rejection caused by a concurrent commit from another surface. */
export const CONFLICT_MESSAGE = '名单已被其他窗口修改，请刷新后重做（本次改动将丢弃）'
/** Import refusal for a document written by a newer plugin build. */
export const IMPORT_VERSION_MESSAGE = '文件版本高于当前支持（只读兼容），请升级插件'
/** Rename confirmation shown when an existing role's name changes. */
export const RENAME_CONFIRM_MESSAGE = '改名后，后续派单需使用新名字'
/** toolFilter advisory: unknown tool names are never validated. */
export const TOOL_FILTER_UNKNOWN_HINT = '保存后以实际工具面为准'
/** toolFilter advisory from the Task 8 review (member-side dispatch roles). */
export const TOOL_FILTER_SUGGESTION = '供成员派单的角色建议配置 toolFilter 收窄工具面'

/** How the form holds the toolFilter tri-state. */
export type ToolFilterMode = 'none' | 'deny' | 'allow'

/** Everything the edit form inputs hold; numeric/optional fields stay strings. */
export interface RosterDraft {
  /** Trimmed on save; duplicate-checked live while typing. */
  name: string
  /** Single emoji, loosely validated (warning, not error). */
  icon: string
  description: string
  persona: string
  modelPolicy: RosterAgent['modelPolicy']
  provider: string
  model: string
  /** Adapter-owned raw string; empty means unset. */
  reasoningEffort: string
  /** Numeric string; empty means unset. */
  maxTokens: string
  toolFilterMode: ToolFilterMode
  /** Comma-separated tool names; split/trimmed on save. */
  toolFilterInput: string
  /** Numeric string (≥ 1); default `3`. */
  maxDepth: string
  backgroundMode: RosterAgent['backgroundMode']
  fallback: RosterAgent['fallback']
  enabled: boolean
}

/** Fields a validation error can land on, for in-place rendering. */
export type DraftField =
  | 'name' | 'icon' | 'description' | 'persona' | 'provider' | 'model'
  | 'reasoningEffort' | 'maxTokens' | 'toolFilter' | 'maxDepth'

/** `validateDraft` outcome: the validator's messages keyed by form field,
 * plus the roster-level issues (roster cap, schema…) that map to no field —
 * the form banner lists them verbatim so nothing is swallowed. */
export interface DraftValidation {
  ok: boolean
  fieldErrors: Partial<Record<DraftField, string>>
  otherErrors: RosterIssue[]
}

/** The all-defaults draft behind 新增角色. */
export function emptyDraft(): RosterDraft {
  return {
    name: '',
    icon: '',
    description: '',
    persona: '',
    modelPolicy: 'inherit',
    provider: '',
    model: '',
    reasoningEffort: '',
    maxTokens: '',
    toolFilterMode: 'none',
    toolFilterInput: '',
    maxDepth: '3',
    backgroundMode: 'continuable',
    fallback: 'error',
    enabled: true,
  }
}

function splitToolNames(input: string): string[] {
  return input.split(',').map((name) => name.trim()).filter((name) => name !== '')
}

/** Compose the saved agent from the draft. Defaults mirror the schema layer. */
export function agentFromDraft(draft: RosterDraft): RosterAgent {
  const name = draft.name.trim()
  const agent: RosterAgent = {
    name,
    description: draft.description,
    persona: draft.persona,
    modelPolicy: draft.modelPolicy,
    maxDepth: Number.parseInt(draft.maxDepth, 10) || 3,
    backgroundMode: draft.backgroundMode,
    fallback: draft.fallback,
    enabled: draft.enabled,
  }
  const icon = draft.icon.trim()
  if (icon !== '') agent.icon = icon
  if (draft.modelPolicy === 'fixed') {
    const provider = draft.provider.trim()
    const model = draft.model.trim()
    if (provider !== '') agent.provider = provider
    if (model !== '') agent.model = model
  }
  // Invalid numeric input is carried INTO the validator (0/NaN/negative) so
  // the error renders in place; only an EMPTY field falls back to the default.
  const depth = Number.parseInt(draft.maxDepth.trim(), 10)
  agent.maxDepth = draft.maxDepth.trim() === '' ? 3 : depth
  const reasoningEffort = draft.reasoningEffort
  if (reasoningEffort !== '') agent.reasoningEffort = reasoningEffort
  if (draft.maxTokens.trim() !== '') agent.maxTokens = Number.parseInt(draft.maxTokens.trim(), 10)
  if (draft.toolFilterMode !== 'none') {
    // Keep the chosen mode even when the list parses empty: the shared
    // validator then rejects it in place (`deny must not be empty`) instead of
    // the save silently dropping the filter the UI still shows.
    const tools = splitToolNames(draft.toolFilterInput)
    agent.toolFilter = draft.toolFilterMode === 'deny' ? { deny: tools } : { allow: tools }
  }
  return agent
}

/** Seed the edit form from an existing (normalized) agent. */
export function draftFromAgent(agent: RosterAgent): RosterDraft {
  return {
    name: agent.name,
    icon: agent.icon ?? '',
    description: agent.description,
    persona: agent.persona,
    modelPolicy: agent.modelPolicy,
    provider: agent.provider ?? '',
    model: agent.model ?? '',
    reasoningEffort: agent.reasoningEffort ?? '',
    maxTokens: agent.maxTokens === undefined || agent.maxTokens === null ? '' : String(agent.maxTokens),
    toolFilterMode: agent.toolFilter === undefined || agent.toolFilter === null
      ? 'none'
      : 'deny' in agent.toolFilter ? 'deny' : 'allow',
    toolFilterInput: agent.toolFilter === undefined || agent.toolFilter === null
      ? ''
      : ('deny' in agent.toolFilter ? agent.toolFilter.deny : agent.toolFilter.allow).join(', '),
    maxDepth: String(agent.maxDepth),
    backgroundMode: agent.backgroundMode,
    fallback: agent.fallback,
    enabled: agent.enabled,
  }
}

/** Live duplicate-name check for the typing hint; the edited agent never trips on itself. */
export function nameConflict(name: string, roster: RosterConfig, editingIndex: number | null): boolean {
  const key = name.trim()
  if (key === '') return false
  return roster.agents.some((agent, index) => index !== editingIndex && agent.name.trim() === key)
}

/** Does saving this draft need the rename confirmation? */
export function needsRenameConfirm(editing: boolean, originalName: string, newName: string): boolean {
  return editing && originalName.trim() !== newName.trim()
}

/**
 * Validate one draft in roster context: assemble the whole candidate config
 * (the agent replaces `editingIndex`, or is appended when `editingIndex` is
 * null) and run the SAME validator the host write path uses, then fold the
 * indexed error paths back onto form fields.
 */
export function validateDraft(
  draft: RosterDraft,
  roster: RosterConfig,
  editingIndex: number | null,
): DraftValidation {
  const agent = agentFromDraft(draft)
  const agents = [...roster.agents]
  if (editingIndex === null) agents.push(agent)
  else agents[editingIndex] = agent
  const candidate: RosterConfig = { ...roster, schemaVersion: 1, agents }

  const result = validateRoster(candidate)
  const fieldErrors: DraftValidation['fieldErrors'] = {}
  const otherErrors: RosterIssue[] = []
  // The edited slot inside the candidate: the existing index, or the append
  // position for a brand-new agent.
  const editedSlot = editingIndex ?? roster.agents.length
  for (const issue of result.errors) {
    const field = fieldOf(issue, editedSlot)
    if (field === undefined) {
      otherErrors.push(issue)
    } else if (fieldErrors[field] === undefined) {
      fieldErrors[field] = issue.msg
    }
  }
  return { ok: result.ok, fieldErrors, otherErrors }
}

const DRAFT_FIELDS: readonly DraftField[] = [
  'name', 'icon', 'description', 'persona', 'provider', 'model',
  'reasoningEffort', 'maxTokens', 'toolFilter', 'maxDepth',
]

function fieldOf(issue: RosterIssue, editedSlot: number): DraftField | undefined {
  // Paths look like `agents[<i>]`, `agents[<i>].<field>`, or nested under the
  // field (`agents[<i>].toolFilter.deny[0]`); only issues on the edited/new
  // slot map to a field — roster-level errors (caps, schema) stay on the
  // form-level banner the card renders from the raw issues.
  const match = /^agents\[(\d+)\](?:\.([^.]+))?/.exec(issue.path)
  if (match === null) return undefined
  if (Number(match[1]) !== editedSlot) return undefined
  if (match[2] === undefined) return 'name'
  return DRAFT_FIELDS.includes(match[2] as DraftField) ? match[2] as DraftField : undefined
}

/** Import outcome — all-or-nothing: `ok` carries the WHOLE replacement roster. */
export type ImportOutcome =
  | { ok: true; roster: RosterConfig; replaced: number }
  | { ok: false; kind: 'parse'; message: string }
  | { ok: false; kind: 'version'; message: typeof IMPORT_VERSION_MESSAGE }
  | { ok: false; kind: 'invalid'; issues: RosterIssue[] }

/**
 * Parse an imported document. The text must read back through the shared
 * pipeline (`readRoster` → `validateRoster`) in full before anything is
 * returned; a newer schema refuses with the read-only upgrade message and no
 * partial roster ever escapes (the caller only replaces on `ok: true`).
 */
export function importRosterText(text: string): ImportOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, kind: 'parse', message: `JSON 解析失败：${String(error instanceof Error ? error.message : error)}` }
  }
  const read = readRoster(parsed)
  if (read.ok) return { ok: true, roster: read.roster, replaced: read.roster.agents.length }
  // Task 8 handoff: narrow the RosterRead union with `'readonly' in read`.
  if ('readonly' in read) return { ok: false, kind: 'version', message: IMPORT_VERSION_MESSAGE }
  return { ok: false, kind: 'invalid', issues: read.errors }
}

/** The stable download text for 导出 (pretty-printed, trailing newline). */
export function exportRosterText(roster: RosterConfig): string {
  return `${JSON.stringify(roster, null, 2)}\n`
}

/** Flip one agent's `enabled` immutably (the row toggle write). */
export function rosterWithToggledEnabled(roster: RosterConfig, index: number): RosterConfig {
  const agents = roster.agents.map((agent, i) => i === index ? { ...agent, enabled: !agent.enabled } : agent)
  return { ...roster, agents }
}

/** Replace the whole autoChain immutably (the roster-level auto editor). */
export function rosterWithAutoChain(roster: RosterConfig, autoChain: RosterAutoChainRoute[]): RosterConfig {
  return { ...roster, autoChain }
}
