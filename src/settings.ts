/**
 * Host-side settings registration and hot roster access.
 *
 * This file is the ONLY host-coupled half of the roster read path: it owns
 * the schemastery mirror of `RosterConfig`, the `installSection` seam on the
 * fork's Config composition, and the live readers dispatch consumes. The
 * pure pipeline it feeds lives in `roster-read.ts`, which stays importable by
 * the client bundle (zero host dependencies).
 *
 * Semantics (per the settings contract of @deepseek-ai/dsh-settings):
 * - `installSection` layers the `ROSTER_NS` section under the user document,
 *   with the composition entry as the base layer; the plugin keeps working
 *   when no settings provider is mounted (the inject callback simply never
 *   runs — the fiber pends on the optional `settings` service exactly like
 *   the existing lazy `commands`/web registrations).
 * - `setSource` keeps the current source closure; `getRoster()` re-reads it
 *   on EVERY call — no caching — so a committed settings change is visible to
 *   the next dispatch decision without re-registration.
 * - `onChange` fans out to subscribers registered via `onRosterChange`; each
 *   subscription returns its own unsubscribe function.
 * - `validate` refuses (throws) writes `validateRoster` cannot bless — cross-
 *   field requirements (fixed policy routes), roster caps, duplicates — and
 *   refuses newer schemas, which load read-only.
 *
 * Note: the provider is reached through a local structural type instead of
 * importing `@deepseek-ai/dsh-settings`, so the plugin needs no new
 * dependency to attach to the shared settings service; the runtime contract
 * (`ctx.settings.installSection(owner, ns, schema, entry, hooks)`) is the
 * package's public `SettingsProvider.installSection` signature.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ROSTER_NS, validateRoster, type RosterConfig } from './schema.ts'
import { readRoster, type RosterRead } from './roster-read.ts'
import type { Config } from './index.ts'

/** Hooks the roster hands to the settings provider (SettingsSectionHooks shape). */
interface RosterSectionHooks {
  /** Receive the active source thunk (resolved scope while attached, entry otherwise). */
  setSource(current: () => RosterConfig): void
  /** Re-judge derived state after attach/detach/commit. */
  onChange(): void
  /** Refuse a resolved section the roster could not act on. */
  validate?: (value: RosterConfig) => void
}

/** Structural view of the host settings provider this plugin consumes. */
interface RosterSettingsProvider {
  installSection(
    owner: Context,
    ns: typeof ROSTER_NS,
    schema: z<RosterConfig>,
    entry: RosterConfig,
    hooks: RosterSectionHooks,
  ): unknown
}

/**
 * Schemastery mirror of `RosterConfig` for the settings page. This schema
 * renders and resolves; authoritative validation stays in `validateRoster`
 * (enforced by the `validate` hook), so structural limits live in one place.
 */
export const RosterSettingsSchema: z<RosterConfig> = z.object({
  schemaVersion: z.number().default(1),
  transport: z.union([z.const('spawn'), z.const('fork')]).default('spawn'),
  agents: z.array(z.object({
    name: z.string().required(),
    icon: z.string(),
    description: z.string().required(),
    persona: z.string().required(),
    modelPolicy: z.union([z.const('inherit'), z.const('fixed'), z.const('auto')]).default('inherit'),
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
    maxTokens: z.union([z.natural(), z.const(null)]),
    toolFilter: z.union([
      z.object({ deny: z.array(z.string()).min(1).required() }),
      z.object({ allow: z.array(z.string()).min(1).required() }),
      z.const(null),
    ]),
    maxDepth: z.natural().default(3),
    backgroundMode: z.union([z.const('continuable'), z.const('one-shot')]).default('continuable'),
    fallback: z.union([z.const('error'), z.const('inherit')]).default('error'),
    enabled: z.boolean().default(true),
  })).default([]),
  autoChain: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
  })).default([]),
})

/** Current source closure; the composition entry until the provider re-points it. */
let currentSource: () => unknown = () => undefined
/** Subscribers notified on committed roster changes. */
const listeners = new Set<() => void>()

/**
 * Read the CURRENT roster: validation + normalization, fresh on every call.
 * Returns the three-state `RosterRead`; an empty/default section is a legal
 * empty roster. Never caches.
 */
export function getRoster(): RosterRead {
  return readRoster(currentSource())
}

/**
 * Subscribe to committed roster changes. Returns the unsubscribe function.
 */
export function onRosterChange(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

/**
 * Register the `ROSTER_NS` settings namespace on the fork's Config
 * composition. Called from the plugin `apply`; does not disturb the other
 * mount surfaces. Re-registration (plugin reload) re-points the source and
 * clears subscribers, so stale closures from a previous fiber cannot fire.
 */
export function registerRosterSettings(ctx: Context, config: Config): void {
  // Composition base layer = the all-defaults roster. Roster composition
  // fields (if any are added to `Config`) thread into this entry.
  void config
  const entry: RosterConfig = { schemaVersion: 1, transport: 'spawn', agents: [], autoChain: [] }
  currentSource = () => entry
  listeners.clear()

  const validate = (value: RosterConfig): void => {
    const result = validateRoster(value)
    if (result.readonly) {
      throw new Error(
        `subagent-roster: schemaVersion ${String(value.schemaVersion)} is newer than this build — refusing the write (loads read-only)`,
      )
    }
    if (!result.ok) {
      const detail = result.errors.map(issue => `${issue.path === '' ? 'root' : issue.path}: ${issue.msg}`).join('; ')
      throw new Error(`subagent-roster: invalid roster section — ${detail}`)
    }
  }
  const setSource = (current: () => RosterConfig): void => {
    currentSource = current
  }
  const onChange = (): void => {
    for (const listener of [...listeners]) listener()
  }

  ctx.inject(['settings'], (settingsCtx) => {
    const provider = (settingsCtx as { settings?: RosterSettingsProvider }).settings
    if (provider === undefined) return
    try {
      provider.installSection(ctx, ROSTER_NS, RosterSettingsSchema, entry, {
        validate,
        setSource,
        onChange,
      })
    } catch (error) {
      // Task 9 D1 (Task 3 review Important): installSection reads the STORED
      // section and throws when it cannot resolve — a legacy corrupt document
      // used to take the whole plugin down ("not loaded" instead of the
      // designed read-only degrade). Log the exact cause and fall back to the
      // composition entry (the all-defaults roster): the plugin stays alive,
      // the user sees an empty roster, and nothing is written to storage.
      const logger = (ctx as { logger?: { warn?: (message: string) => void } }).logger
      logger?.warn?.(
        `subagent-roster: installSection failed (${String(error)}) — falling back to the default roster entry; `
        + `the stored "${ROSTER_NS}" section is left untouched`,
      )
    }
  })
}
