import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

/** The closed-namespace roster activation command. */
export const ROSTER_COMMAND = 'roster'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'subagent-roster-command': { readonly kind: 'subagent-roster-command'; readonly goal?: string }
  }
}

const GESTURE = /^\/roster(?=$|[\t\n\r ])/u

/** One roster activation invocation parsed from user text. */
export interface RosterInvocation {
  goal: string
}

/** Parse a `/roster` gesture (with or without the leading slash) into a goal. */
export function parseRosterInvocation(text: string): RosterInvocation {
  return { goal: text.trim() }
}

/** Parse either the slash command or the plain-text gesture. */
function parseCommandText(text: string): RosterInvocation | undefined {
  const trimmed = text.trimStart()
  if (GESTURE.test(trimmed)) return parseRosterInvocation(trimmed.slice(ROSTER_COMMAND.length + 1).trim())
  return undefined
}

export function invokedRosterInvocation(messages: readonly UserMessage[]): RosterInvocation | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      const invocation = parseCommandText(block.text)
      if (invocation !== undefined) return invocation
    }
  }
  return undefined
}

export function buildActivationDirective(goal: string): string {
  const lines = [
    'The user invoked the /roster command. Follow the roster protocol already in your system instructions: if unsure which roles exist, call roster_list first, then dispatch the suitable named role with roster_agent.',
    'Pass the goal below as the role\'s self-contained prompt. There is no team state to create, approve, or resume — this plugin only dispatches named roles.',
  ]
  lines.push(goal === '' ? 'The goal was not given — ask the user what the dispatched role should accomplish.' : `Goal: ${goal}`)
  return lines.join('\n')
}

export function registerRosterCommand(ctx: Context): void {
  ctx.effect(() => {
    return ctx.commands.register({
      name: ROSTER_COMMAND,
      description: 'dispatch a named roster role for a goal (roster protocol)',
      input: { hint: '<goal>' },
      handler(invocation: CommandInvocation): CommandResult {
        const parsed = parseRosterInvocation(invocation.rawInput.trim())
        if (parsed.goal === '') return { kind: 'error', text: `Usage: /${ROSTER_COMMAND} <goal>` }
        // The host command is only the admission surface: its input is
        // replayed as the visible user message, and the gesture boundary
        // (agent/pre-step) turns it into the roster directive.
        invocation.agent.followup(createUserMessage({ content: [{ type: 'text', text: `/${ROSTER_COMMAND}${invocation.rawInput}` }], source: { kind: 'user' } }))
        return { kind: 'success', text: 'Roster activation — the model will dispatch a suitable named role.' }
      },
    })
  }, 'subagent-roster: slash command')
}

export function installRosterGestureBoundary(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    let invocation: RosterInvocation | undefined
    try { invocation = invokedRosterInvocation(messages) } catch (error: unknown) { return { kind: 'enter', messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text: `Roster gesture parsing failed: ${String(error)}` }], source: { kind: 'subagent-roster-command' } })] } }
    if (invocation === undefined) return decision
    signal.throwIfAborted()
    return { kind: 'enter', messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text: buildActivationDirective(invocation.goal) }], source: { kind: 'subagent-roster-command', ...invocation.goal === '' ? {} : { goal: invocation.goal } } })] }
  })
}
