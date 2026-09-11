/**
 * RosterCard — the plugin's user-visible face in Settings → Plugins, rendered
 * into the keyed `settings.plugin.item` slot (key = the `subagent-roster`
 * namespace) and backed by the host settings scope with revision fencing.
 *
 * Structure (Task 9 A–C):
 * - The roster list: one row per role (icon, name, truncated description,
 *   model-policy badge shared with the system-prompt section, background-mode
 *   badge, enabled toggle, edit entry).
 * - The shared add/edit form: every Task 9 field, validated IN PLACE through
 *   the same `validateRoster` the host write path refuses with (the pure half
 *   lives in `roster-form.ts`). Renaming an existing role asks for explicit
 *   confirmation; a save refused by the revision fence shows the conflict
 *   message instead of failing silently.
 * - Import/export: the export downloads the current config as
 *   `subagent-roster.json`; the import is all-or-nothing (whole-document
 *   validation, per-field located errors, `schemaVersion > 1` refused with
 *   the read-only upgrade message).
 *
 * The revision fence follows the fork's StagingPlanEditor pattern: the editor
 * captures the namespace revision when the draft OPENS and passes it back as
 * `expectedRevision`, so a commit from another surface between open and save
 * is refused instead of silently overwritten. Immediate single-flip actions
 * (row toggle, import, autoChain edit) fence on the latest revision instead.
 *
 * The `settings.plugin.item` slot contract and the settings scope are typed
 * through LOCAL STRUCTURAL TYPES on purpose: the fork takes no dependency on
 * `dsh-client-ui-settings(-plugins)`, the bundle purity gate forbids
 * cross-plugin value imports, and this mirrors the `src/settings.ts` pattern
 * for the host provider seam.
 * @module dsh-subagent-roster/client/roster-card
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type FormEvent } from 'react'
import type { RosterAgent, RosterAutoChainRoute, RosterConfig } from '../schema.ts'
import { readRoster } from '../roster-read.ts'
import { modelPolicyBadge } from '../section.ts'
import {
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
  type DraftField,
  type RosterDraft,
  type ToolFilterMode,
} from './roster-form.ts'
import type { SubagentRosterTranslate } from './roster-locales.ts'
import css from './RosterCard.module.css'

/** One ordered field operation (mirror of the wire `SettingsPathOpView`). */
export type RosterSettingsOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/**
 * Local structural mirror of the per-namespace settings scope (the runtime
 * object is the host's `ctx.settingsScope.bind(...)` product). Only the face
 * this card consumes is declared.
 */
export interface RosterSettingsScope {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: unknown
    revision: number | undefined
    writable: boolean
    mode: 'host' | 'memory'
  }
  subscribe(listener: () => void): () => void
  /** Atomic multi-op write; `expectedRevision` pins the revision fence. */
  mutate(ops: readonly RosterSettingsOp[], expectedRevision?: number): Promise<void>
  /** Stop queued writes and wait for the wire call in flight. */
  dispose(): Promise<void>
}

/** Local structural mirror of the `ctx.settingsScope` binder. */
export interface RosterSettingsScopeBinder {
  bind(spec: { namespace: string }): RosterSettingsScope
}

/** The card only consumes the injected scope and the locale function. */
export interface RosterCardProps {
  readonly scope: RosterSettingsScope | undefined
  readonly t: SubagentRosterTranslate
}

/** Feedback banner state; successes auto-dismiss (StagingPlanEditor pattern). */
interface Feedback {
  readonly tone: 'success' | 'error'
  readonly message: string
  readonly detail?: readonly string[]
}

/** An open editor session: the draft plus the fence captured at open time. */
interface EditSession {
  readonly index: number | null
  readonly draft: RosterDraft
  readonly originalName: string
  readonly openRevision: number | undefined
}

/** Is this rejection the revision fence (another surface won the race)? The
 * host refuses a stale fence with `SettingsConflictError`; the name is the
 * primary signal and the message text is the wire-mangled fallback. */
function isConflictError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'SettingsConflictError') return true
    return /conflict|revision/i.test(error.message)
  }
  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Stable no-op store so `useSyncExternalStore` stays honest without a scope. */
function noopSubscribe(listener: () => void): () => void {
  void listener
  return () => {}
}

function noopSnapshot(): null {
  return null
}

/** The exact wire shape of one whole-section replacement. */
function rosterOps(next: RosterConfig): RosterSettingsOp[] {
  return [
    { op: 'set', path: ['schemaVersion'], value: next.schemaVersion },
    { op: 'set', path: ['transport'], value: next.transport },
    { op: 'set', path: ['agents'], value: next.agents },
    { op: 'set', path: ['autoChain'], value: next.autoChain },
  ]
}

export function RosterCard({ scope, t }: RosterCardProps) {
  const snapshot = useSyncExternalStore(
    scope === undefined ? noopSubscribe : (listener) => scope.subscribe(listener),
    scope === undefined ? noopSnapshot : () => scope.getSnapshot(),
  )

  const [busy, setBusy] = useState(false)
  const [session, setSession] = useState<EditSession | null>(null)
  const [renameArmed, setRenameArmed] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [autoChainOpen, setAutoChainOpen] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>()
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (feedback?.tone !== 'success') return
    const timer = window.setTimeout(() => { setFeedback(undefined) }, 3_500)
    return () => { window.clearTimeout(timer) }
  }, [feedback])

  // The three-state read: the SAME `readRoster` the host dispatch path uses,
  // so a readonly future schema and a corrupt document degrade identically.
  const read = useMemo(
    () => readRoster(snapshot === null ? undefined : snapshot.value),
    [snapshot],
  )

  const writable = snapshot !== null && snapshot.writable && read.ok
  const editable = writable && !busy

  /** Whole-section replacement behind one revision fence. */
  const writeRoster = async (next: RosterConfig, fenceRevision: number | undefined): Promise<boolean> => {
    if (scope === undefined) return false
    setBusy(true)
    try {
      await scope.mutate(rosterOps(next), fenceRevision)
      return true
    } catch (error) {
      setFeedback(isConflictError(error)
        ? { tone: 'error', message: t('form.conflict') }
        : { tone: 'error', message: errorMessage(error) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async (index: number): Promise<void> => {
    if (!writable || !read.ok) return
    const ok = await writeRoster(rosterWithToggledEnabled(read.roster, index), undefined)
    if (ok) setFeedback(undefined)
  }

  const openCreate = (): void => {
    setSession({
      index: null,
      draft: emptyDraft(),
      originalName: '',
      openRevision: snapshot?.revision,
    })
    setRenameArmed(false)
    setRemoving(false)
    setFeedback(undefined)
  }

  const openEdit = (agent: RosterAgent, index: number): void => {
    setSession({
      index,
      draft: draftFromAgent(agent),
      originalName: agent.name,
      openRevision: snapshot?.revision,
    })
    setRenameArmed(false)
    setRemoving(false)
    setFeedback(undefined)
  }

  const closeEditor = (): void => {
    setSession(null)
    setRenameArmed(false)
    setRemoving(false)
  }

  const saveEditor = async (): Promise<void> => {
    if (session === null || !writable || !read.ok) return
    const validation = validateDraft(session.draft, read.roster, session.index)
    if (!validation.ok) {
      setFeedback({ tone: 'error', message: t('form.validationFailed') })
      return
    }
    if (needsRenameConfirm(session.index !== null, session.originalName, session.draft.name) && !renameArmed) {
      setRenameArmed(true)
      return
    }
    const agent = agentFromDraft(session.draft)
    const agents = [...read.roster.agents]
    if (session.index === null) agents.push(agent)
    else agents[session.index] = agent
    const ok = await writeRoster({ ...read.roster, schemaVersion: 1, agents }, session.openRevision)
    if (ok) closeEditor()
  }

  const removeAgent = async (): Promise<void> => {
    if (session === null || session.index === null || !writable || !read.ok) return
    const agents = read.roster.agents.filter((_, index) => index !== session.index)
    const ok = await writeRoster({ ...read.roster, agents }, session.openRevision)
    if (ok) closeEditor()
  }

  const saveAutoChain = async (chain: RosterAutoChainRoute[]): Promise<void> => {
    if (!writable || !read.ok) return
    const ok = await writeRoster(rosterWithAutoChain(read.roster, chain), undefined)
    if (ok) setFeedback({ tone: 'success', message: t('form.save') })
  }

  const downloadExport = (): void => {
    if (!read.ok) return
    const blob = new Blob([exportRosterText(read.roster)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'subagent-roster.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const onImportFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file === undefined || scope === undefined || !writable) return
    const text = await file.text()
    const outcome = importRosterText(text)
    if (!outcome.ok) {
      if (outcome.kind === 'parse') {
        setFeedback({ tone: 'error', message: t('import.parseFailed', { message: outcome.message }) })
      } else if (outcome.kind === 'version') {
        setFeedback({ tone: 'error', message: outcome.message })
      } else {
        setFeedback({
          tone: 'error',
          message: t('import.invalid'),
          detail: outcome.issues.map((issue) => `${issue.path === '' ? 'root' : issue.path}: ${issue.msg}`),
        })
      }
      return
    }
    // all-or-nothing: only here does anything get written.
    const ok = await writeRoster(outcome.roster, undefined)
    if (ok) setFeedback({ tone: 'success', message: t('import.success', { count: outcome.replaced }) })
  }

  const unavailable = snapshot === null || snapshot.status === 'unavailable' || scope === undefined
  if (unavailable || snapshot.status === 'loading') {
    return (
      <li className={css.root} data-roster-card>
        <header className={css.head}>
          <span className={css.title}>{t('card.title')}</span>
        </header>
        <p className={css.notice}>
          {snapshot !== null && snapshot.status === 'loading' ? t('card.loading') : t('card.unavailable')}
        </p>
      </li>
    )
  }

  return (
    <li className={css.root} data-roster-card data-readonly={!writable || undefined}>
      <header className={css.head}>
        <span className={css.title}>{t('card.title')}</span>
        {read.ok && (
          <span className={css.count}>{t('card.count', { count: read.roster.agents.length })}</span>
        )}
      </header>
      <p className={css.subtitle}>{t('card.subtitle')}</p>

      {!read.ok && 'readonly' in read && (
        <p className={css.notice} data-tone="error" role="alert">{t('card.readonlySchema')}</p>
      )}
      {!read.ok && !('readonly' in read) && (
        <p className={css.notice} data-tone="error" role="alert">
          {t('card.corrupted')}
          <ul>
            {read.errors.map((issue, index) => (
              <li key={index}>{`${issue.path === '' ? 'root' : issue.path}: ${issue.msg}`}</li>
            ))}
          </ul>
        </p>
      )}
      {!snapshot.writable && (
        <p className={css.notice}>{t('card.unavailable')}</p>
      )}

      <Feedback value={feedback} />

      <div className={css.actions}>
        <button type="button" data-primary disabled={!editable} onClick={openCreate}>
          {t('card.addRole')}
        </button>
        <button type="button" disabled={!editable} onClick={() => { fileInputRef.current?.click() }}>
          {t('card.import')}
        </button>
        <button type="button" disabled={!read.ok || busy} onClick={downloadExport}>
          {t('card.export')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className={css.fileInput}
          onChange={(event) => { void onImportFile(event) }}
        />
      </div>

      {read.ok && read.roster.agents.length === 0 && (
        <p className={css.notice}>{t('card.empty')}</p>
      )}

      {read.ok && (
        <ul className={css.rows}>
          {read.roster.agents.map((agent, index) => (
            <li key={`${agent.name}:${index}`} className={css.row} data-disabled={!agent.enabled}>
              <span className={css.icon} aria-hidden>
                {agent.icon === undefined || agent.icon.trim() === '' ? '👤' : agent.icon}
              </span>
              <span className={css.identity}>
                <span className={css.nameLine}>
                  <span className={css.name} title={agent.name}>{agent.name}</span>
                  <span className={css.badges}>
                    <span className={css.badge}>{modelPolicyBadge(agent)}</span>
                    <span className={css.badge}>
                      {agent.backgroundMode === 'one-shot' ? t('card.badgeOneShot') : t('card.badgeContinuable')}
                    </span>
                  </span>
                </span>
                <span className={css.description} title={agent.description}>{agent.description}</span>
              </span>
              <label className={css.toggle}>
                <input
                  type="checkbox"
                  checked={agent.enabled}
                  disabled={!editable}
                  onChange={() => { void toggleEnabled(index) }}
                />
                <span>{t('card.enabled')}</span>
              </label>
              <button type="button" disabled={!editable} onClick={() => { openEdit(agent, index) }}>
                {t('card.edit')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {read.ok && (
        <AutoChainEditor
          open={autoChainOpen}
          onToggle={() => { setAutoChainOpen((current) => !current) }}
          chain={read.roster.autoChain}
          editable={editable}
          onSave={(chain) => { void saveAutoChain(chain) }}
          t={t}
        />
      )}

      {session !== null && read.ok && (
        <Editor
          session={session}
          roster={read.roster}
          busy={busy}
          renameArmed={renameArmed}
          removing={removing}
          onRenameDisarm={() => { setRenameArmed(false) }}
          onRemoveArm={setRemoving}
          onDraft={(draft) => { setSession({ ...session, draft }) }}
          onSave={() => { void saveEditor() }}
          onRemove={() => { void removeAgent() }}
          onClose={closeEditor}
          t={t}
        />
      )}
    </li>
  )
}

/** Auto-dismissing feedback banner (role flips on tone, fork pattern). */
function Feedback({ value }: { readonly value: Feedback | undefined }) {
  if (value === undefined) return null
  return (
    <p className={css.notice} data-tone={value.tone} role={value.tone === 'error' ? 'alert' : 'status'}>
      {value.message}
      {value.detail !== undefined && (
        <ul>
          {value.detail.map((line, index) => <li key={index}>{line}</li>)}
        </ul>
      )}
    </p>
  )
}

/** The roster-level auto-chain editor: local draft rows committed on blur,
 * add/remove committed immediately — never one write per keystroke. */
function AutoChainEditor({ open, onToggle, chain, editable, onSave, t }: {
  readonly open: boolean
  readonly onToggle: () => void
  readonly chain: RosterAutoChainRoute[]
  readonly editable: boolean
  readonly onSave: (chain: RosterAutoChainRoute[]) => void
  readonly t: SubagentRosterTranslate
}) {
  const [draft, setDraft] = useState(chain)
  useEffect(() => { setDraft(chain) }, [chain])
  const commit = (next: RosterAutoChainRoute[]): void => {
    setDraft(next)
    onSave(next)
  }
  const editRow = (index: number, patch: Partial<RosterAutoChainRoute>): void => {
    setDraft(draft.map((item, i) => i === index ? { ...item, ...patch } : item))
  }
  // Adding a row only extends the LOCAL draft: the host validator refuses an
  // empty route, so the write waits for the row's first blur (fill or remove).
  const addRow = (): void => {
    setDraft([...draft, { provider: '', model: '' }])
  }
  return (
    <section className={css.autoChain} data-auto-chain data-open={open}>
      <button type="button" onClick={onToggle} aria-expanded={open}>
        {t('card.autoChainTitle')}
      </button>
      {open && (
        <>
          <p className={css.autoChainHint}>{t('card.autoChainHint')}</p>
          {draft.length === 0 && <p className={css.autoChainHint}>{t('card.autoChainEmpty')}</p>}
          {draft.map((route, index) => (
            <div key={index} className={css.autoChainRow}>
              <span className={css.chainIndex}>{index + 1}</span>
              <input
                type="text"
                value={route.provider}
                aria-label={t('card.autoChainProvider')}
                disabled={!editable}
                onChange={(event) => { editRow(index, { provider: event.currentTarget.value }) }}
                onBlur={() => { commit(draft) }}
              />
              <input
                type="text"
                value={route.model}
                aria-label={t('card.autoChainModel')}
                disabled={!editable}
                onChange={(event) => { editRow(index, { model: event.currentTarget.value }) }}
                onBlur={() => { commit(draft) }}
              />
              <button
                type="button"
                data-danger
                disabled={!editable}
                onClick={() => { commit(draft.filter((_, i) => i !== index)) }}
              >
                {t('card.autoChainRemove')}
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={!editable}
            onClick={addRow}
          >
            {t('card.autoChainAdd')}
          </button>
        </>
      )}
    </section>
  )
}

/** The shared add/edit form. */
function Editor({ session, roster, busy, renameArmed, removing, onRenameDisarm, onRemoveArm, onDraft, onSave, onRemove, onClose, t }: {
  readonly session: EditSession
  readonly roster: RosterConfig
  readonly busy: boolean
  readonly renameArmed: boolean
  readonly removing: boolean
  readonly onRenameDisarm: () => void
  readonly onRemoveArm: (removing: boolean) => void
  readonly onDraft: (draft: RosterDraft) => void
  readonly onSave: () => void
  readonly onRemove: () => void
  readonly onClose: () => void
  readonly t: SubagentRosterTranslate
}) {
  const { draft } = session
  const set = (patch: Partial<RosterDraft>): void => {
    onDraft({ ...draft, ...patch })
    // Any draft change disarms a pending rename confirmation.
    onRenameDisarm()
    onRemoveArm(false)
  }
  const validation = useMemo(
    () => validateDraft(draft, roster, session.index),
    [draft, roster, session.index],
  )
  const duplicate = nameConflict(draft.name, roster, session.index)
  const fieldError = (field: DraftField): string | undefined => validation.fieldErrors[field]

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    onSave()
  }

  return (
    <form className={css.editor} data-roster-editor onSubmit={submit}>
      <p className={css.editorTitle}>
        {session.index === null
          ? t('form.newTitle')
          : t('form.editTitle', { name: session.originalName })}
      </p>

      <div className={css.field}>
        <span className={css.fieldHead}>
          <label htmlFor="roster-name">{t('form.name')}</label>
        </span>
        <input
          id="roster-name"
          type="text"
          value={draft.name}
          data-invalid={duplicate || fieldError('name') !== undefined || undefined}
          onChange={(event) => { set({ name: event.currentTarget.value }) }}
        />
        {duplicate
          ? <span className={css.fieldError}>{t('form.nameDuplicate')}</span>
          : <span className={css.hint}>{t('form.nameHint')}</span>}
        {fieldError('name') !== undefined && <span className={css.fieldError}>{fieldError('name')}</span>}
      </div>

      <div className={css.grid}>
        <div className={css.field}>
          <span className={css.fieldHead}><label htmlFor="roster-icon">{t('form.icon')}</label></span>
          <input
            id="roster-icon"
            type="text"
            value={draft.icon}
            onChange={(event) => { set({ icon: event.currentTarget.value }) }}
          />
        </div>
        <div className={css.field}>
          <span className={css.fieldHead}>
            <label htmlFor="roster-description">{t('form.description')}</label>
            <span className={css.counter} data-over={draft.description.length > 100 || undefined}>
              {t('form.descriptionCounter', { count: draft.description.length })}
            </span>
          </span>
          <input
            id="roster-description"
            type="text"
            value={draft.description}
            data-invalid={fieldError('description') !== undefined || undefined}
            onChange={(event) => { set({ description: event.currentTarget.value }) }}
          />
          {fieldError('description') !== undefined && <span className={css.fieldError}>{fieldError('description')}</span>}
        </div>
      </div>

      <div className={css.field}>
        <span className={css.fieldHead}>
          <label htmlFor="roster-persona">{t('form.persona')}</label>
          <span className={css.counter} data-over={draft.persona.length > 20_000 || undefined}>
            {t('form.personaCounter', { count: draft.persona.length })}
          </span>
        </span>
        <textarea
          id="roster-persona"
          rows={4}
          value={draft.persona}
          data-invalid={fieldError('persona') !== undefined || undefined}
          onChange={(event) => { set({ persona: event.currentTarget.value }) }}
        />
        {fieldError('persona') !== undefined && <span className={css.fieldError}>{fieldError('persona')}</span>}
      </div>

      <div className={css.field}>
        <span className={css.fieldHead}><span>{t('form.modelPolicy')}</span></span>
        <div className={css.triRow}>
          {(['inherit', 'fixed', 'auto'] as const).map((policy) => (
            <label key={policy}>
              <input
                type="radio"
                name="roster-model-policy"
                checked={draft.modelPolicy === policy}
                onChange={() => { set({ modelPolicy: policy }) }}
              />
              <span>{t(`form.modelPolicy.${policy}`)}</span>
            </label>
          ))}
        </div>
      </div>

      {draft.modelPolicy === 'fixed' && (
        <div className={css.grid}>
          <div className={css.field}>
            <span className={css.fieldHead}><label htmlFor="roster-provider">{t('form.provider')}</label></span>
            <input
              id="roster-provider"
              type="text"
              value={draft.provider}
              data-invalid={fieldError('provider') !== undefined || undefined}
              onChange={(event) => { set({ provider: event.currentTarget.value }) }}
            />
            {fieldError('provider') !== undefined && <span className={css.fieldError}>{fieldError('provider')}</span>}
          </div>
          <div className={css.field}>
            <span className={css.fieldHead}><label htmlFor="roster-model">{t('form.model')}</label></span>
            <input
              id="roster-model"
              type="text"
              value={draft.model}
              data-invalid={fieldError('model') !== undefined || undefined}
              onChange={(event) => { set({ model: event.currentTarget.value }) }}
            />
            {fieldError('model') !== undefined && <span className={css.fieldError}>{fieldError('model')}</span>}
          </div>
        </div>
      )}

      {draft.modelPolicy === 'auto' && (
        <p className={css.hint}>
          {roster.autoChain.length === 0
            ? t('form.autoChainHint.empty')
            : t('form.autoChainHint.configured', {
              chain: roster.autoChain.map((route) => `${route.provider}/${route.model}`).join(' → '),
            })}
        </p>
      )}
      {draft.modelPolicy === 'auto' && (
        <div className={css.field}>
          <span className={css.fieldHead}><label htmlFor="roster-fallback">{t('form.fallback')}</label></span>
          <select
            id="roster-fallback"
            value={draft.fallback}
            onChange={(event) => { set({ fallback: event.currentTarget.value as RosterDraft['fallback'] }) }}
          >
            <option value="error">{t('form.fallback.error')}</option>
            <option value="inherit">{t('form.fallback.inherit')}</option>
          </select>
        </div>
      )}

      <div className={css.grid}>
        <div className={css.field}>
          <span className={css.fieldHead}>
            <label htmlFor="roster-effort">{t('form.reasoningEffort')}</label>
          </span>
          {/* TEXT input, never a dropdown: the raw string is adapter-owned and
              passes through verbatim (Task 9 B). */}
          <input
            id="roster-effort"
            type="text"
            value={draft.reasoningEffort}
            onChange={(event) => { set({ reasoningEffort: event.currentTarget.value }) }}
          />
          <span className={css.hint}>{t('form.reasoningEffortHint')}</span>
        </div>
        <div className={css.field}>
          <span className={css.fieldHead}><label htmlFor="roster-max-tokens">{t('form.maxTokens')}</label></span>
          <input
            id="roster-max-tokens"
            type="number"
            min={1}
            value={draft.maxTokens}
            data-invalid={fieldError('maxTokens') !== undefined || undefined}
            onChange={(event) => { set({ maxTokens: event.currentTarget.value }) }}
          />
          {fieldError('maxTokens') !== undefined && <span className={css.fieldError}>{fieldError('maxTokens')}</span>}
        </div>
      </div>

      <div className={css.field}>
        <span className={css.fieldHead}>
          <span>{t('form.toolFilter')}</span>
          <span className={css.hint}>{t('form.toolFilterSuggestion')}</span>
        </span>
        <div className={css.triRow}>
          {(['none', 'deny', 'allow'] as const).map((mode) => (
            <label key={mode}>
              <input
                type="radio"
                name="roster-tool-filter"
                checked={draft.toolFilterMode === mode}
                onChange={() => { set({ toolFilterMode: mode as ToolFilterMode }) }}
              />
              <span>{t(`form.toolFilter.${mode}`)}</span>
            </label>
          ))}
        </div>
        {draft.toolFilterMode !== 'none' && (
          <>
            <input
              type="text"
              value={draft.toolFilterInput}
              placeholder={t('form.toolFilterPlaceholder')}
              data-invalid={fieldError('toolFilter') !== undefined || undefined}
              onChange={(event) => { set({ toolFilterInput: event.currentTarget.value }) }}
            />
            <span className={css.hint}>{t('form.toolFilterUnknownHint')}</span>
          </>
        )}
        {fieldError('toolFilter') !== undefined && <span className={css.fieldError}>{fieldError('toolFilter')}</span>}
      </div>

      <div className={css.grid}>
        <div className={css.field}>
          <span className={css.fieldHead}><label htmlFor="roster-max-depth">{t('form.maxDepth')}</label></span>
          <input
            id="roster-max-depth"
            type="number"
            min={1}
            value={draft.maxDepth}
            data-invalid={fieldError('maxDepth') !== undefined || undefined}
            onChange={(event) => { set({ maxDepth: event.currentTarget.value }) }}
          />
          {fieldError('maxDepth') !== undefined && <span className={css.fieldError}>{fieldError('maxDepth')}</span>}
        </div>
        <div className={css.field}>
          <span className={css.fieldHead}><label htmlFor="roster-background">{t('form.backgroundMode')}</label></span>
          <select
            id="roster-background"
            value={draft.backgroundMode}
            onChange={(event) => { set({ backgroundMode: event.currentTarget.value as RosterDraft['backgroundMode'] }) }}
          >
            <option value="continuable">{t('form.backgroundMode.continuable')}</option>
            <option value="one-shot">{t('form.backgroundMode.oneShot')}</option>
          </select>
        </div>
      </div>

      {!validation.ok && (
        <p className={css.formError} role="alert">
          {t('form.validationFailed')}
          {validation.otherErrors.length > 0 && (
            <ul>
              {validation.otherErrors.map((issue, index) => (
                <li key={index}>{`${issue.path === '' ? 'root' : issue.path}: ${issue.msg}`}</li>
              ))}
            </ul>
          )}
        </p>
      )}

      <div className={css.editorActions}>
        {renameArmed ? (
          // The rename confirm layer: the second click commits (fork's
          // discardArmed pattern — armed action row swaps its contents).
          <>
            <span className={css.hint}>{t('form.renameConfirm')}</span>
            <button type="button" disabled={busy} onClick={onRenameDisarm}>{t('form.cancel')}</button>
            <button type="submit" data-primary disabled={busy || duplicate}>{t('form.renameProceed')}</button>
          </>
        ) : (
          <>
            {session.index !== null && (
              removing ? (
                <>
                  <span className={css.hint}>{t('form.removeWarning')}</span>
                  <button type="button" data-danger disabled={busy} onClick={onRemove}>{t('form.removeConfirm')}</button>
                  <button type="button" disabled={busy} onClick={() => { onRemoveArm(false) }}>{t('form.cancel')}</button>
                </>
              ) : (
                <button type="button" data-danger disabled={busy} onClick={() => { onRemoveArm(true) }}>
                  {t('form.remove')}
                </button>
              )
            )}
            <span className={css.spacer} />
            <button type="button" disabled={busy} onClick={onClose}>{t('form.cancel')}</button>
            <button type="submit" data-primary disabled={busy || duplicate}>
              {busy ? t('form.saving') : t('form.save')}
            </button>
          </>
        )}
      </div>
    </form>
  )
}
