/**
 * Named team-profile templates: config types, normalization, invocation
 * parsing, and prompt rendering.
 *
 * Pure functions only — no I/O, no spawn. Runtime create/spawn stays in
 * `tools.ts`; this module only turns a config map + a profile name into a
 * validated member-roster template (or parses `--profile` flags).
 *
 * Narrowed from the agent-teams fork: profiles carry people and guardrails
 * only — seed task graphs and review policies were removed with the task
 * DAG and quality gates.
 *
 * @module dsh-subagent-roster/profiles
 */

import { CAPTAIN_KEY, sanitizeKey } from './state.ts'

/** Hard cap on named profiles so the usage prompt cannot grow without bound. */
export const MAX_TEAM_PROFILES = 16
/** Protocol excerpt length in the usage / prompt listing. */
export const PROFILE_PROTOCOL_PROMPT_LIMIT = 240

const PROFILE_KEYS = ['description', 'protocol', 'executionPrompt', 'fallback', 'members'] as const
const MEMBER_KEYS = ['name', 'role', 'provider', 'model', 'reasoning_effort', 'executionPrompt', 'fallback'] as const
const FALLBACK_KEYS = ['provider', 'model'] as const

/** One member row in a named team-profile template (unresolved). */
export interface TeamModelFallbackConfig {
  provider: string
  model: string
}

export interface TeamProfileMemberConfig {
  name: string
  role?: string
  provider?: string
  model?: string
  reasoning_effort?: string
  executionPrompt?: string
  fallback?: TeamModelFallbackConfig
}

/** One named team-profile template from plugin config. */
export interface TeamProfileConfig {
  description?: string
  protocol?: string
  executionPrompt?: string
  fallback?: TeamModelFallbackConfig
  members: TeamProfileMemberConfig[]
}

/** A profile member after trim / pairing / reserved-name checks. */
export interface NormalizedProfileMember {
  name: string
  role?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  executionPrompt?: string
  fallback?: TeamModelFallbackConfig
}

/** A fully validated team profile: a named member roster. */
export interface NormalizedTeamProfile {
  name: string
  description?: string
  protocol?: string
  executionPrompt?: string
  fallback?: TeamModelFallbackConfig
  members: NormalizedProfileMember[]
}

/** The goal + optional named profile extracted from a slash / gesture line. */
export interface AgentTeamsInvocation {
  goal: string
  profile?: string
}

/** One configured profile after key trim, for listing / lookup. */
export interface ListedTeamProfile {
  name: string
  config: TeamProfileConfig
}

/**
 * Trim every profile key once, reject empty / colliding keys, and reject
 * more than {@link MAX_TEAM_PROFILES} entries. Does not validate profile
 * bodies — that belongs to {@link resolveTeamProfile}.
 */
export function listConfiguredProfiles(
  profiles: Record<string, TeamProfileConfig> | undefined | null,
): ListedTeamProfile[] {
  const record = asProfilesRecord(profiles)
  const keys = Object.keys(record)
  if (keys.length > MAX_TEAM_PROFILES) {
    throw new Error(`too many AgentTeams profiles (${keys.length}); the limit is ${MAX_TEAM_PROFILES}`)
  }
  const seen = new Map<string, string>()
  const listed: ListedTeamProfile[] = []
  for (const rawKey of keys) {
    const name = rawKey.trim()
    if (name === '') {
      throw new Error('configured AgentTeams profiles include an empty key')
    }
    const previous = seen.get(name)
    if (previous !== undefined) {
      throw new Error(`configured AgentTeams profiles have duplicate key "${name}"`)
    }
    seen.set(name, rawKey)
    listed.push({ name, config: record[rawKey] as TeamProfileConfig })
  }
  return listed
}

/**
 * Render the usage-prompt listing. One line per profile: name, member count,
 * protocol excerpt (at most 240 characters). Returns `''` when nothing is
 * configured so callers can omit the capability entirely.
 */
export function formatProfilesForPrompt(
  profiles: Record<string, TeamProfileConfig> | undefined | null,
): string {
  const listed = listConfiguredProfiles(profiles)
  if (listed.length === 0) return ''
  const lines = [
    'Configured team profiles (pass profile= to agent_teams_create):',
    ...listed.map((entry) => formatProfileListingLine(entry)),
  ]
  return lines.join('\n')
}

/**
 * Walk `rawInput` from the front and eat standalone profile flags. Only
 * `--profile <name>`, `--profile=<name>`, and `profile=<name>` count; the
 * first ordinary token stops the scan so a mid-sentence `profile=` stays in
 * the goal. A leading ordinary token is never treated as a profile name.
 *
 * `--profile "name"` strips one matching pair of quotes. Repeat flags and a
 * `--profile` with no name throw.
 */
export function parseProfileInvocation(rawInput: string): AgentTeamsInvocation {
  const tokens = tokenize(rawInput)
  let index = 0
  let profile: string | undefined
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) break
    const parsed = parseLeadingProfileFlag(token, tokens[index + 1])
    if (parsed === undefined) break
    if (profile !== undefined) {
      throw new Error('duplicate AgentTeams profile flag')
    }
    profile = parsed.name
    index += parsed.consumed
  }
  const goal = tokens.slice(index).join(' ')
  return profile === undefined ? { goal } : { goal, profile }
}

/**
 * Normalize and pre-validate one named profile. Failures throw before any
 * caller should create a directory or spawn members.
 */
export function resolveTeamProfile(
  profiles: Record<string, TeamProfileConfig>,
  profileName: string,
  maxMembers: number,
): NormalizedTeamProfile {
  const listed = listConfiguredProfiles(profiles)
  const name = profileName.trim()
  if (name === '') {
    throw new Error('AgentTeams profile name must be a non-empty string')
  }
  const match = listed.find((entry) => entry.name === name)
  if (match === undefined) {
    const available = listed.map((entry) => entry.name)
    const shown = available.length === 0 ? '(none)' : available.join(', ')
    throw new Error(`unknown AgentTeams profile "${name}" — configured profiles: ${shown}`)
  }
  return normalizeListedProfile(match, maxMembers)
}

function formatProfileListingLine(entry: ListedTeamProfile): string {
  const memberCount = Array.isArray(entry.config.members) ? entry.config.members.length : 0
  const counts = `(${countLabel(memberCount, 'member')})`
  const summary = protocolSummary(entry.config.protocol) ?? protocolSummary(entry.config.description)
  return summary === undefined
    ? `- ${entry.name} ${counts}`
    : `- ${entry.name} ${counts}: ${summary}`
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function protocolSummary(protocol: string | undefined): string | undefined {
  if (typeof protocol !== 'string') return undefined
  const collapsed = protocol.trim().replace(/\s+/gu, ' ')
  if (collapsed === '') return undefined
  return collapsed.length <= PROFILE_PROTOCOL_PROMPT_LIMIT
    ? collapsed
    : collapsed.slice(0, PROFILE_PROTOCOL_PROMPT_LIMIT)
}

function tokenize(rawInput: string): string[] {
  const trimmed = rawInput.trim()
  if (trimmed === '') return []
  return trimmed.split(/\s+/u)
}

function parseLeadingProfileFlag(
  token: string,
  nextToken: string | undefined,
): { name: string; consumed: number } | undefined {
  if (token === '--profile') {
    if (nextToken === undefined) {
      throw new Error('--profile flag is missing a profile name')
    }
    return { name: readProfileToken(nextToken), consumed: 2 }
  }
  if (token.startsWith('--profile=')) {
    return { name: readProfileToken(token.slice('--profile='.length)), consumed: 1 }
  }
  if (token.startsWith('profile=')) {
    return { name: readProfileToken(token.slice('profile='.length)), consumed: 1 }
  }
  return undefined
}

function readProfileToken(raw: string): string {
  const name = stripOneQuotePair(raw).trim()
  if (name === '') {
    throw new Error('--profile flag is missing a profile name')
  }
  return name
}

/** Strip a single matching pair of `"` or `'` quotes; leave unmatched quotes alone. */
function stripOneQuotePair(value: string): string {
  if (value.length < 2) return value
  const first = value.at(0)
  const last = value.at(-1)
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}

function normalizeListedProfile(
  listed: ListedTeamProfile,
  maxMembers: number,
): NormalizedTeamProfile {
  const path = `profiles.${listed.name}`
  const raw = asRecord(listed.config, path)
  assertAllowedKeys(raw, PROFILE_KEYS, path)

  const description = optionalNonEmptyString(raw['description'], `${path}.description`)
  const protocol = optionalNonEmptyString(raw['protocol'], `${path}.protocol`)
  const executionPrompt = optionalNonEmptyString(raw['executionPrompt'], `${path}.executionPrompt`)
  const fallback = normalizeFallback(raw['fallback'], `${path}.fallback`)
  const membersRaw = raw['members']
  if (!Array.isArray(membersRaw) || membersRaw.length === 0) {
    throw new Error(`AgentTeams profile "${listed.name}" has no members`)
  }
  if (membersRaw.length > maxMembers) {
    throw new Error(
      `profile "${listed.name}" has ${membersRaw.length} members but maxMembers is ${maxMembers}`,
    )
  }

  const members: NormalizedProfileMember[] = []
  const memberByKey = new Map<string, NormalizedProfileMember>()
  for (let index = 0; index < membersRaw.length; index += 1) {
    const member = normalizeMember(membersRaw[index], `${path}.members[${index}]`, listed.name)
    const key = sanitizeKey(member.name)
    const colliding = memberByKey.get(key)
    if (colliding !== undefined) {
      throw new Error(
        `profile members "${colliding.name}" and "${member.name}" collapse to the same name`,
      )
    }
    memberByKey.set(key, member)
    members.push(member)
  }

  return omitUndefined({
    name: listed.name,
    description,
    protocol,
    executionPrompt,
    fallback,
    members,
  })
}

function normalizeMember(
  value: unknown,
  path: string,
  profileName: string,
): NormalizedProfileMember {
  const raw = asRecord(value, path)
  assertAllowedKeys(raw, MEMBER_KEYS, path)
  const name = requiredNonEmptyString(raw['name'], `${path}.name`, `profile "${profileName}" has a member with an empty name`)
  if (isCaptainName(name)) {
    throw new Error(`member name "${name}" is reserved for the captain`)
  }
  const role = optionalNonEmptyString(raw['role'], `${path}.role`)
  const provider = optionalNonEmptyString(raw['provider'], `${path}.provider`)
  const model = optionalNonEmptyString(raw['model'], `${path}.model`)
  const reasoningEffort = optionalNonEmptyString(raw['reasoning_effort'], `${path}.reasoning_effort`)
  const executionPrompt = optionalNonEmptyString(raw['executionPrompt'], `${path}.executionPrompt`)
  const fallback = normalizeFallback(raw['fallback'], `${path}.fallback`)
  if (provider !== undefined && model === undefined) {
    throw new Error(`profile member "${name}" sets provider without model`)
  }
  return omitUndefined({ name, role, provider, model, reasoningEffort, executionPrompt, fallback })
}

function normalizeFallback(value: unknown, path: string): TeamModelFallbackConfig | undefined {
  if (value === undefined) return undefined
  const raw = asRecord(value, path)
  assertAllowedKeys(raw, FALLBACK_KEYS, path)
  const provider = requiredNonEmptyString(raw['provider'], `${path}.provider`, `${path}.provider must not be empty`)
  const model = requiredNonEmptyString(raw['model'], `${path}.model`, `${path}.model must not be empty`)
  return { provider, model }
}

function isCaptainName(name: string): boolean {
  return name.trim().toLowerCase() === CAPTAIN_KEY || sanitizeKey(name) === CAPTAIN_KEY
}

function asProfilesRecord(
  profiles: Record<string, TeamProfileConfig> | undefined | null,
): Record<string, unknown> {
  if (profiles === undefined || profiles === null) return {}
  if (typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new Error('AgentTeams profiles must be an object map of named templates')
  }
  return profiles as Record<string, unknown>
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allow = new Set<string>(allowed)
  for (const key of Object.keys(value)) {
    if (allow.has(key)) continue
    const suggestion = suggestField(key, allowed)
    const hint = suggestion === undefined ? '' : `; did you mean ${suggestion}?`
    throw new Error(`${path}.${key} is unknown${hint}`)
  }
}

function suggestField(unknown: string, allowed: readonly string[]): string | undefined {
  const lower = unknown.toLowerCase()
  const exact = allowed.find((candidate) => candidate.toLowerCase() === lower)
  if (exact !== undefined) return exact
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of allowed) {
    const distance = levenshtein(lower, candidate.toLowerCase())
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  if (best !== undefined && bestDistance <= 2) return best
  return undefined
}

function levenshtein(left: string, right: string): number {
  const rows = left.length + 1
  const cols = right.length + 1
  const grid: number[][] = []
  for (let row = 0; row < rows; row += 1) {
    const line: number[] = []
    for (let col = 0; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1
      const del = (grid[row - 1]?.[col] ?? 0) + 1
      const ins = (grid[row]?.[col - 1] ?? 0) + 1
      const sub = (grid[row - 1]?.[col - 1] ?? 0) + cost
      const cell = grid[row] as number[] | undefined
      if (cell !== undefined) cell[col] = Math.min(del, ins, sub)
    }
  }
  return grid[left.length]?.[right.length] ?? 0
}

function requiredNonEmptyString(
  value: unknown,
  path: string,
  emptyMessage: string,
): string {
  if (value === undefined || typeof value !== 'string') {
    throw new Error(`${path} must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed === '') throw new Error(emptyMessage)
  return trimmed
}

function optionalNonEmptyString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new Error(`${path} must not be empty`)
  }
  return trimmed
}

function omitUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) delete value[key]
  }
  return value
}
