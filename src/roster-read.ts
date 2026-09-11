/**
 * Pure roster read pipeline: raw stored/edited data → validated, normalized
 * `RosterConfig`.
 *
 * Like `schema.ts`, this module is deliberately dependency-free (no host, no
 * cordis, no DOM) so the client half — which must satisfy the bundle-purity
 * gate — can reuse the exact same read path as settings and dispatch.
 *
 * Three-state contract (`RosterRead`):
 * - `{ ok: true, roster }` — validated input with every default filled in by
 *   `normalizeAgent`; consumers may use `roster` as a complete config.
 * - `{ ok: false, readonly: true }` — the stored `schemaVersion` is newer
 *   than this build; NO roster is returned (downgrades must not read, and the
 *   settings card uses this branch to disable writing).
 * - `{ ok: false, errors }` — a corrupted roster; every error points at the
 *   offending field via the validator's indexed paths.
 *
 * An absent or default-shaped source (`undefined`, `{}`, `{schemaVersion: 1}`)
 * is a legal empty roster, not corruption: it resolves to the all-defaults
 * `RosterConfig` (no agents, empty autoChain, `spawn` transport). A missing
 * `schemaVersion` defaults to `1` for the same reason defaulted fields are
 * legal elsewhere in the schema.
 */

import { normalizeAgent, validateRoster, type RosterConfig, type RosterIssue } from './schema.ts'

/** Result of reading a roster source. See the module docs for the contract. */
export type RosterRead =
  | { ok: true; roster: RosterConfig }
  | { ok: false; readonly: true }
  | { ok: false; errors: RosterIssue[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a roster from raw settings-shaped data. Validates first (read-only
 * future schemas short-circuit), then fills the documented defaults into
 * every agent. The input is never mutated.
 */
export function readRoster(source: unknown): RosterRead {
  const raw = source === undefined ? {} : source
  const candidate = isRecord(raw) && raw['schemaVersion'] === undefined
    ? { schemaVersion: 1, ...raw }
    : raw

  const validation = validateRoster(candidate)
  if (validation.readonly) return { ok: false, readonly: true }
  if (!validation.ok) return { ok: false, errors: validation.errors }

  const section = isRecord(candidate) ? candidate : {}
  const agentsRaw = section['agents']
  const autoChainRaw = section['autoChain']
  const roster: RosterConfig = {
    schemaVersion: 1,
    transport: section['transport'] === 'fork' ? 'fork' : 'spawn',
    agents: Array.isArray(agentsRaw) ? agentsRaw.map(normalizeAgent) : [],
    autoChain: Array.isArray(autoChainRaw)
      ? autoChainRaw.map(route => {
        const entry = isRecord(route) ? route : {}
        // `validateRoster` already rejected entries missing either key.
        return { provider: entry['provider'] as string, model: entry['model'] as string }
      })
      : [],
  }
  return { ok: true, roster }
}
