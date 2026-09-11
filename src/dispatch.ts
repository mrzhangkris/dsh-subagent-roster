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
 * @module dsh-subagent-roster/dispatch
 */

import type { DispatchSpec } from './roster.ts'

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
