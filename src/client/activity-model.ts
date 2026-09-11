/** Pure relationship projections used by the AgentTeams activity panel. */

/** Compact `provider/model` route, or just the model when the provider is absent. */
export function memberRouteLabel(member: { readonly provider?: string; readonly model?: string } | undefined): string {
  if (member === undefined) return ''
  const provider = member.provider?.trim() ?? ''
  const model = member.model?.trim() ?? ''
  if (provider !== '' && model !== '') return `${provider}/${model}`
  return model
}

/**
 * Compact route shown on a running task. Prefer the task's own snapshot
 * field; fall back to the assignee member when older hosts omit it.
 */
export function taskModelLabel(
  task: { readonly model?: string; readonly assignee: string },
  members: readonly { readonly name: string; readonly provider?: string; readonly model?: string }[],
): string {
  const direct = task.model?.trim() ?? ''
  if (direct !== '') return direct
  return memberRouteLabel(members.find((candidate) => candidate.name === task.assignee))
}

/** Short model id for tight chips (`openai/gpt-5.6-sol` → `gpt-5.6-sol`). */
export function compactModelLabel(route: string): string {
  const trimmed = route.trim()
  if (trimmed === '') return ''
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/** A live team the current captain still owns and has not halted. */
export function liveCaptainTeam<T extends { readonly captainSessionId: string; readonly halted?: boolean }>(
  teams: readonly T[],
  sessionId: string | undefined,
): T | undefined {
  const owner = sessionId?.trim() ?? ''
  if (owner === '') return undefined
  return teams.find((team) => team.captainSessionId === owner && team.halted !== true)
}

/** Whether the captain chat should keep showing the in-progress banner. */
export function teamIsActive(team: {
  readonly phase?: string
  readonly halted?: boolean
  readonly members: readonly { readonly status?: string; readonly activity?: string }[]
  readonly tasks: readonly { readonly status: string }[]
}): boolean {
  if (team.halted === true || team.phase === 'staged') return false
  if (team.members.some((member) => member.activity === 'working' || member.status === 'working')) return true
  if (team.tasks.some((task) => task.status === 'pending' || task.status === 'claimed' || task.status === 'in_progress')) return true
  return team.members.length > 0 && team.tasks.length === 0
}

/** Compact banner copy: running members, otherwise the current planning state. */
export function teamProgressSummary(
  team: {
    readonly members: readonly { readonly name: string; readonly status?: string; readonly activity?: string; readonly currentTask?: string }[]
    readonly tasks: readonly { readonly id: string; readonly subject: string; readonly status: string }[]
  },
  separator: string,
): { readonly working: number; readonly detail: string } {
  const workingMembers = team.members.filter((member) => member.activity === 'working' || member.status === 'working')
  const runningTasks = team.tasks.filter((task) => task.status === 'claimed' || task.status === 'in_progress')
  const labels = runningTasks.map((task) => task.subject.trim() || task.id).filter((label) => label !== '')
  if (workingMembers.length > 0 || labels.length > 0) {
    return {
      working: Math.max(workingMembers.length, labels.length),
      detail: labels.slice(0, 2).join(separator),
    }
  }
  if (team.tasks.length === 0) return { working: 0, detail: '' }
  return { working: 0, detail: '' }
}

/**
 * Whether an expanded activity panel still belongs to the current session.
 *
 * The panel is mounted in the root-scoped shell overlay, so React does not
 * remount it when the conversation route changes. Ownership keeps an expanded
 * panel from leaking onto the new-session screen (or another conversation)
 * while its local open state is being reset.
 */
export function activityPanelExpandedForSession(
  open: boolean,
  owner: string | undefined,
  current: string | undefined,
): boolean {
  return open && owner !== undefined && owner === current
}

/** Inputs for deciding whether genuinely new live work may expand the panel. */
export interface ActivityPanelAutoExpandInput {
  readonly alreadyAutoOpened: boolean
  readonly pageSettled: boolean
  readonly restoreComplete: boolean
  readonly previousLiveTeamIds: ReadonlySet<string>
  readonly currentLiveTeamIds: readonly string[]
}

/**
 * Auto-expand only for live teams that appear after the current session's
 * initial restore pass. Replayed cards, archived teams, and live teams restored
 * while reopening a conversation must remain behind the collapsed badge.
 */
export function activityPanelShouldAutoExpand({
  alreadyAutoOpened,
  pageSettled,
  restoreComplete,
  previousLiveTeamIds,
  currentLiveTeamIds,
}: ActivityPanelAutoExpandInput): boolean {
  return !alreadyAutoOpened
    && pageSettled
    && restoreComplete
    && currentLiveTeamIds.some((teamId) => !previousLiveTeamIds.has(teamId))
}
