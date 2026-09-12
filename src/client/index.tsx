/** Browser plugin for the subagent-roster settings card. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the official browser locale service into ClientContext.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the slot registry (ctx.slots) into ClientContext.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SubagentRosterLocaleKey } from './roster-locales.ts'
import {
  SUBAGENT_ROSTER_LOCALE_NAMESPACE,
  en as rosterEn,
  zh as rosterZh,
} from './roster-locales.ts'
import { ROSTER_NS } from '../schema.ts'
import { RosterCard, type RosterSettingsScopeBinder, type RosterSettingsScope } from './RosterCard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** RosterCard settings-card copy. */
    subagentRoster: SubagentRosterLocaleKey
  }
}

/** Required services: slots for the settings-card slot and locale for copy. */
export const inject = ['slots', 'locale']

/**
 * RosterCard: the plugin's settings card, dispatched by the Settings →
 * Plugins tab through the keyed `settings.plugin.item` slot (key = the
 * roster's settings namespace). The `settingsScope` service is injected
 * LAZILY — the same optional-seam philosophy as the host half's settings
 * registration — so a client environment without it simply renders no card
 * instead of failing the whole browser plugin. The slot contract types are
 * local structural mirrors (see RosterCard.tsx): the fork takes no
 * dependency on dsh-client-ui-settings(-plugins).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(SUBAGENT_ROSTER_LOCALE_NAMESPACE, { zh: rosterZh, en: rosterEn }),
    'subagent-roster: dictionaries',
  )

  ctx.inject(['settingsScope'], (scopeCtx) => {
    const binder = (scopeCtx as unknown as { settingsScope?: RosterSettingsScopeBinder }).settingsScope
    if (binder === undefined) return
    const scope: RosterSettingsScope = binder.bind({ namespace: ROSTER_NS })
    ctx.effect(
      () => () => { void scope.dispose() },
      'subagent-roster: settings scope disposal',
    )
    const slotHost = ctx.slots as unknown as {
      inject(key: string, build: () => unknown): void
      register(options: Record<string, unknown>, component: unknown): () => void
    }
    slotHost.inject('settings.plugin.item', () => slotHost.register({
      name: 'settings.plugin.item',
      key: ROSTER_NS,
      locale: SUBAGENT_ROSTER_LOCALE_NAMESPACE,
      inject: () => ({ scope }),
    }, RosterCard))
  })
}
