/**
 * Continuable dispatch link: turn a resolved `DispatchSpec` into exactly one
 * host `ctx.subagents.startContinuable` call. Like `roster.ts`, this module
 * is deliberately host-import-free — the host surface arrives injected in
 * `deps.subagents` (production wires `ctx.subagents` in `index.ts`; tests
 * inject a mock), so the whole link stays unit-testable against the exact
 * field contract below.
 *
 * The request shape mirrors the fork's own `spawnMember` call surface
 * (`members.ts`) and the host `ContinuableStartSpec`: the per-member knobs
 * ride inside `request`, the initial prompt is a `ContentBlock[]`
 * (`[{ type: 'text', text }]`, not a bare string), and the top level carries
 * only `provider`/`label`/`request`/`signal`.
 *
 * Behavior contract (each clause is pinned by `test/dispatch-continuable.test.ts`):
 * - Parent defense: a missing parent throws with a message naming `parent`
 *   and no request is issued — the official tool-subagent line, kept at the
 *   first use instead of surfacing as a deep host error.
 * - Transport validity: anything but `spawn`/`fork` throws before any
 *   request — the route is validated at the seam, not left to the provider.
 * - Request construction: `provider` = transport, `label` = spec.label
 *   (e.g. 「📚 百晓」), `request.parent` = the live parent agent,
 *   `request.persona` = spec.persona, `request.prompt` = the given prompt
 *   text wrapped as one text content block, `request.maxDepth` = spec.maxDepth,
 *   and `request.agentOptions`/`request.toolFilter` passed through only when
 *   the spec carries them (same omit-when-absent convention as `spawnMember`).
 * - Result and failure passthrough: the host `{ childId, messageId }` is
 *   returned verbatim and a host rejection propagates unwrapped — error
 *   mapping belongs to the tool layer, not here.
 *
 * The one-shot half (`dispatchOneShotForeground` / `dispatchOneShotBackground`)
 * mirrors the official tool-subagent settlement semantics, contract for
 * contract:
 * - Foreground: result and disposal run under `Promise.allSettled` — a failed
 *   cleanup never replaces an independent result, and a double failure
 *   aggregates both messages (official `settleForegroundRun` shape, reported
 *   as `{ ok: false, ... }` instead of thrown because the tool layer renders
 *   the outcome itself).
 * - stopReason: `completed` → ok with the flattened text; the official
 *   `aborted`/`error`/`max-tokens`/`refusal` headlines; any other or a
 *   MISSING reason falls back to failure carrying 「unknown stop reason」
 *   (merge-extensible unions must not pass as success). Provider
 *   `diagnostic` text and preserved partial assistant text (official
 *   「Partial output before the run ended:」 block) ride the detail.
 * - Background: a `jobs.start({ kind: 'subagent', owner: parent, ... })`
 *   task whose `run` owns its own `AbortController` — the controller's
 *   signal (never the host `exec.signal` object) goes to `start`, host
 *   aborts are forwarded onto it, and settlement follows official
 *   `settleStart`: `signal.aborted && !(error instanceof AggregateError)`
 *   → killed (cancellation must not launder a failed cleanup), otherwise
 *   failed with the error text.
 *
 * Note: background settlement reuses the official `settleRun` from the
 * `@deepseek-ai/dsh-subagent` ROOT export (the `./run-settlement` subpath is
 * not in the exports map, but the root barrel re-exports it) — the aborted
 * → killed / diagnostic-abort → failed mapping is the official code path,
 * not a local reimplementation.
 * @module dsh-subagent-roster/dispatch
 */

import type { DispatchSpec } from './roster.ts'
// Official settlement: the package ROOT export carries settleRun (the
// `./run-settlement` subpath is not in the exports map, but the root barrel
// re-exports it — same entry the official tool-subagent imports).
import { settleRun } from '@deepseek-ai/dsh-subagent'

/**
 * The slice of the host `ctx.subagents` surface this module touches —
 * narrowed from the injected `unknown` at the single call site.
 */
interface SubagentsLike {
  startContinuable(spec: {
    provider: string
    label: string
    request: {
      prompt: { type: 'text'; text: string }[]
      parent: unknown
      persona: string
      agentOptions?: DispatchSpec['agentOptions']
      toolFilter?: DispatchSpec['toolFilter']
      maxDepth?: number
    }
    signal?: AbortSignal
  }): Promise<{ childId: string; messageId: string }>
  /**
   * The one-shot start seam: `provider` routes to the provider family, the
   * rest of the request rides as the second bundle. Mirrors the continuable
   * call shape so tests inject the same nested request.
   */
  start(spec: {
    provider: string
    label: string
    request: {
      prompt: { type: 'text'; text: string }[]
      parent: unknown
      persona: string
      agentOptions?: DispatchSpec['agentOptions']
      toolFilter?: DispatchSpec['toolFilter']
      maxDepth?: number
    }
    signal?: AbortSignal
  }): Promise<SubagentRunLike>
}

/** The slice of the host `SubagentRun` this module settles. */
interface SubagentRunLike {
  readonly id: string
  readonly result: Promise<SubagentResultLike>
  dispose(): Promise<void> | void
}

/** The slice of the host `SubagentResult` this module reads. */
interface SubagentResultLike {
  readonly output: readonly { type: string; text?: string }[]
  readonly diagnostic?: string
  readonly stopReason?: string
}

/** Outcome shape of a settled one-shot background task (host `JobOutcome`). */
interface JobOutcome {
  status: 'completed' | 'failed' | 'killed'
  output?: string
  detail?: string
}

/** The slice of the host `ctx.jobs` service the background path touches. */
interface JobsLike {
  start(spec: {
    kind: string
    label: string
    owner: unknown
    run: () => { cancel: (reason?: string) => void; done: Promise<JobOutcome> }
  }): string
}

/** Services the dispatch link needs; production injects the host context. */
export interface DispatchDeps {
  /** Host `ctx.subagents` (mocked in tests). */
  subagents: unknown
}

/** One continuable dispatch request, as the tool layer resolves it. */
export interface ContinuableArgs {
  /** Parent Agent object (the host `exec.agent`); undefined must throw. */
  agent: unknown
  /** The roster transport: which subagent provider family creates the child. */
  transport: 'spawn' | 'fork'
  /** The resolved roster spec (see `roster.ts`). */
  spec: DispatchSpec
  /** The initial user prompt for the child's first turn. */
  prompt: string
  /** Caller cancellation, forwarded to the host start when provided. */
  signal?: AbortSignal
}

/**
 * Dispatch one durable continuable child from a resolved roster spec.
 * @param deps - injected host services (only `subagents` is read).
 * @param args - the parent agent, transport, spec, and initial prompt.
 * @returns the host start result: durable child id and inbox message id.
 */
export async function dispatchContinuable(
  deps: DispatchDeps, args: ContinuableArgs,
): Promise<{ childId: string; messageId: string }> {
  if (args.agent === undefined || args.agent === null) {
    throw new Error(
      'roster dispatch: no parent agent — continuable dispatch needs the live parent Agent (args.agent); '
      + 'this tool can only run from inside an agent turn',
    )
  }
  if (args.transport !== 'spawn' && args.transport !== 'fork') {
    throw new Error(`roster dispatch: invalid transport ${JSON.stringify(String(args.transport))} — expected "spawn" or "fork"`)
  }
  const { startContinuable } = deps.subagents as SubagentsLike
  const start = await startContinuable({
    provider: args.transport,
    label: args.spec.label,
    request: {
      prompt: [{ type: 'text', text: args.prompt }],
      parent: args.agent,
      persona: args.spec.persona,
      ...(args.spec.toolFilter === undefined ? {} : { toolFilter: args.spec.toolFilter }),
      ...(args.spec.agentOptions === undefined ? {} : { agentOptions: args.spec.agentOptions }),
      maxDepth: args.spec.maxDepth,
    },
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  })
  return { childId: start.childId, messageId: start.messageId }
}

/** One-shot dispatch services: the host context plus (background only) jobs. */
export interface OneShotDeps extends DispatchDeps {
  /** Host `ctx.jobs` service; required for the background path only. */
  jobs?: unknown
}

/** One one-shot dispatch request, as the tool layer resolves it. */
export interface OneShotArgs {
  /** Parent Agent object (the host `exec.agent`); undefined must throw. */
  agent: unknown
  /** The roster transport: which subagent provider family creates the child. */
  transport: 'spawn' | 'fork'
  /** The resolved roster spec (see `roster.ts`). */
  spec: DispatchSpec
  /** The user prompt for the child's single turn. */
  prompt: string
  /**
   * Host `exec.signal`. Foreground: forwarded to the start call. Background:
   * only observed — aborts are forwarded onto the task-owned controller,
   * which is built inside the jobs task `run`.
   */
  signal?: AbortSignal
}

/** The foreground settlement result: final text, or a titled failure. */
export type OneShotForegroundResult =
  | { ok: true; text: string; detail?: string }
  | { ok: false; errorTitle: string; detail: string }

/** Render an error (incl. AggregateError inner errors) into detail text. */
function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    const head = error.message === '' ? 'AggregateError' : error.message
    return `${head}: [${error.errors.map(inner => String(inner)).join('; ')}]`
  }
  return String(error)
}

/** Shared start-request construction (kept isomorphic across the three links). */
function buildRequest(
  agent: unknown, transport: 'spawn' | 'fork', spec: DispatchSpec, prompt: string,
): { provider: string; label: string; request: Parameters<SubagentsLike['start']>[0]['request'] } {
  return {
    provider: transport,
    label: spec.label,
    request: {
      prompt: [{ type: 'text', text: prompt }],
      parent: agent,
      persona: spec.persona,
      ...(spec.toolFilter === undefined ? {} : { toolFilter: spec.toolFilter }),
      ...(spec.agentOptions === undefined ? {} : { agentOptions: spec.agentOptions }),
      maxDepth: spec.maxDepth,
    },
  }
}

/** Parent + transport defenses shared by all three dispatch links. */
function assertDispatchable(args: { agent: unknown; transport: string }): void {
  if (args.agent === undefined || args.agent === null) {
    throw new Error(
      'roster dispatch: no parent agent — one-shot dispatch needs the live parent Agent (args.agent); '
      + 'this tool can only run from inside an agent turn',
    )
  }
  if (args.transport !== 'spawn' && args.transport !== 'fork') {
    throw new Error(`roster dispatch: invalid transport ${JSON.stringify(String(args.transport))} — expected "spawn" or "fork"`)
  }
}

/** Official headline wording for a non-`completed` stop reason. */
function stopReasonError(result: SubagentResultLike): string {
  switch (result.stopReason) {
    case 'completed':
      return ''
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    // Merge-extensible union: a backend may add stop reasons — and a
    // missing/undefined reason is likewise NOT a success. Both fall back to
    // a failure whose headline carries the 「unknown stop reason」 semantics.
    default:
      return `subagent run ended abnormally (unknown stop reason: ${String(result.stopReason)})`
  }
}

/** Flatten the child's text blocks without trusting arbitrary values. */
function outputText(blocks: SubagentResultLike['output']): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/**
 * Append provider-authored failure detail and the preserved partial answer,
 * keeping diagnostic text separate from the child's assistant output.
 */
function withDiagnosticAndPartialText(error: string, result: SubagentResultLike): string {
  const diagnostic = result.diagnostic === undefined ? '' : `\nDiagnostic: ${result.diagnostic}`
  const text = outputText(result.output)
  const partial = text.length === 0 ? '' : `\nPartial output before the run ended:\n${text}`
  return `${error}${diagnostic}${partial}`
}

/**
 * Dispatch a one-shot child and wait for its settlement, mirroring the
 * official `settleForegroundRun`: result and disposal settle independently,
 * a failed cleanup never replaces the child's outcome, and a double failure
 * aggregates both messages.
 */
export async function dispatchOneShotForeground(
  deps: OneShotDeps, args: OneShotArgs,
): Promise<OneShotForegroundResult> {
  assertDispatchable(args)
  const { start } = deps.subagents as SubagentsLike
  const run = await start({
    ...buildRequest(args.agent, args.transport, args.spec, args.prompt),
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  })

  // Phase 1: the child's terminal result, mapped off the stop reason.
  let execution: { ok: true; text: string } | { ok: false; title: string; detail: string }
  const executionSettled = await Promise.allSettled([
    run.result.then((result): { ok: true; text: string } => {
      const error = stopReasonError(result)
      if (error !== '') {
        // Partial output is not success, but the preserved partial answer
        // still reaches the parent through the detail.
        throw new Error(withDiagnosticAndPartialText(error, result))
      }
      return { ok: true, text: outputText(result.output) }
    }),
  ])
  if (executionSettled[0]!.status === 'rejected') {
    const reason = executionSettled[0]!.reason
    const message = reason instanceof Error ? reason.message : String(reason)
    execution = { ok: false, title: message.split('\n')[0] ?? message, detail: message }
  } else {
    execution = executionSettled[0]!.value
  }

  // Phase 2: always release the run, independently of the outcome.
  const disposal = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])

  if (execution.ok) {
    if (disposal[0]!.status === 'rejected') {
      // The good result is NOT swallowed: the child's text stays the result;
      // the cleanup failure rides the detail tail.
      return { ok: true, text: execution.text, detail: `dispose failed: ${formatError(disposal[0]!.reason)}` }
    }
    return execution
  }
  if (disposal[0]!.status === 'rejected') {
    // Aggregate both failures (official AggregateError semantics) — both
    // messages must survive into the reported detail.
    const disposeMessage = formatError(disposal[0]!.reason)
    return {
      ok: false,
      errorTitle: `${execution.title}; dispose failed`,
      detail: `subagent run failed: ${execution.detail}; dispose failed: ${disposeMessage}`,
    }
  }
  return { ok: false, errorTitle: execution.title, detail: execution.detail }
}

/**
 * Settle pending startup without rejecting the task producer contract
 * (official `settleStart`): cancellation must not turn a failed cleanup
 * into a cleanly killed task.
 */
async function settleStart(start: Promise<SubagentRunLike>, signal: AbortSignal): Promise<JobOutcome> {
  try {
    // Official settlement via the package root export: `runOutcome` maps a
    // clean local cancellation (`aborted` without diagnostic) to killed, a
    // provider-diagnosed abort and every other non-completed reason to
    // failed, and keeps both details alive on a double failure.
    return await settleRun(await start as Parameters<typeof settleRun>[0])
  } catch (error: unknown) {
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: formatError(error) }
  }
}

/**
 * Dispatch a one-shot child as a background jobs task and return immediately.
 * The task owns its own `AbortController` (its signal — never the host
 * `exec.signal` object — reaches `start`); host aborts are forwarded onto it.
 */
export function dispatchOneShotBackground(
  deps: OneShotDeps, args: OneShotArgs,
): { jobId: string } {
  assertDispatchable(args)
  const jobs = deps.jobs as JobsLike | undefined
  if (jobs === undefined) {
    throw new Error('roster dispatch: background jobs unavailable — load the host jobs service (deps.jobs)')
  }
  const { start } = deps.subagents as SubagentsLike
  const id = jobs.start({
    kind: 'subagent',
    label: args.spec.label,
    owner: args.agent,
    run: () => {
      const controller = new AbortController()
      // Forward host cancellation onto the task-owned controller.
      if (args.signal !== undefined) {
        args.signal.addEventListener('abort', () => {
          controller.abort(args.signal!.reason ?? 'background subagent task killed')
        }, { once: true })
      }
      const startPromise = start({
        ...buildRequest(args.agent, args.transport, args.spec, args.prompt),
        signal: controller.signal,
      })
      return {
        cancel: (reason?: string) => {
          controller.abort(reason ?? 'background subagent task killed')
        },
        done: settleStart(startPromise, controller.signal),
      }
    },
  })
  return { jobId: id }
}
