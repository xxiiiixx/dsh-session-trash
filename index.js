/**
 * Host half of dsh-session-trash.
 *
 * Wires three things and nothing else: the resolved settings, the one
 * authenticated HTTP route, and the startup retention sweep. Every optional
 * service is read through `ctx.get()`, so a profile without a session registry
 * still loads this plugin and simply answers `unavailable` for the operations
 * that need one.
 *
 * No tool is registered here, by design: deleting a session is a user-only
 * action in this plugin, and the model has no way to call it.
 */

import { resolveSettings } from './lib/config.js'
import { createHandler, registerRoute } from './lib/routes.js'
import { createTrashService } from './lib/trash.js'

/** The one hard dependency: the authenticated fetch channel the route mounts on. */
export const inject = ['connection']

/** Row name shown in plugin inventory output. */
export const name = 'dsh-session-trash'

/**
 * Mount the plugin.
 *
 * @param {import('cordis').Context} ctx - the plugin context.
 * @param {Record<string, unknown> | undefined} config - the Loader row's config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = resolveSettings(config)
  if (!resolved.ok) {
    console.error(`[dsh-session-trash] disabled: ${resolved.reason}`)
    ctx.effect(() => registerRoute(ctx, createHandler(undefined)))
    return
  }

  const settings = resolved.settings
  const host = {
    agents: ctx.get('agents'),
    sessions: ctx.get('sessions'),
    sessionPersistence: ctx.get('sessionPersistence'),
    sessionQuery: ctx.get('sessionQuery'),
    workspaceRegistry: ctx.get('workspaceRegistry'),
  }
  const service = createTrashService({
    settings,
    host,
    emit: (type, payload) => ctx.emit(type, payload),
  })

  ctx.effect(() => registerRoute(ctx, createHandler(service)), 'dsh-session-trash: /api/session-trash route')

  // The retention window runs once per Host start. It is deliberately silent in
  // the UI: no page is connected yet, and a toast about files the user never
  // saw would be noise. Failures are logged and never block the plugin.
  if (settings.sweepOnStart === true && settings.retentionDays > 0) {
    void service.sweep().catch((error) => {
      console.warn('[dsh-session-trash] retention sweep failed:', error instanceof Error ? error.message : error)
    })
  }

  ctx.logger?.debug?.(
    `[dsh-session-trash] sessionsRoot=${settings.sessionsRoot} trashRoot=${settings.trashRoot} retentionDays=${settings.retentionDays}`,
  )
}
