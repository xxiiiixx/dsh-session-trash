/**
 * Configuration resolution.
 *
 * Deliberately dependency-free: this plugin declares no `Config` schema object
 * (which would require importing a schema library the harness resolves inside
 * its own installation), and validates the row's raw config here instead. The
 * result is a frozen, fully-resolved settings record that the rest of the Host
 * half treats as authoritative — no other module re-reads the raw config.
 */

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { areRootsDisjoint } from './paths.js'

/** Defaults, also the documented values in README. */
export const DEFAULTS = Object.freeze({
  sessionsRoot: '',
  trashRoot: '',
  retentionDays: 30,
  sweepOnStart: true,
  maxTrashEntries: 500,
})

/**
 * The DSH home the profile is running from, or undefined outside a profile.
 * @returns {string | undefined} absolute home directory.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  if (typeof homedir === 'function') {
    const home = homedir()
    if (typeof home === 'string' && home !== '') return join(home, '.dsh')
  }
  return undefined
}

/**
 * Read one non-negative integer, falling back to a default.
 * @param {unknown} value - raw configured value.
 * @param {number} fallback - default.
 * @returns {number} the resolved value.
 */
function readCount(value, fallback) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return fallback
}

/**
 * Resolve the row's raw config into the settings the plugin runs with.
 *
 * `sessionsRoot` defaults to `<DSH_HOME>/sessions` (the shipped JSONL backend's
 * own root) and `trashRoot` to its sibling `<DSH_HOME>/session-trash`, so the
 * two are always on the same volume and a move stays a rename.
 *
 * @param {Record<string, unknown> | undefined} raw - the Loader row config.
 * @returns {{ ok: true, settings: Readonly<Record<string, unknown>> } | { ok: false, reason: string }}
 */
export function resolveSettings(raw) {
  const config = raw !== undefined && raw !== null && typeof raw === 'object' ? raw : {}
  const home = dshHome()

  const configuredSessions = typeof config.sessionsRoot === 'string' ? config.sessionsRoot.trim() : ''
  const configuredTrash = typeof config.trashRoot === 'string' ? config.trashRoot.trim() : ''

  const sessionsBase = configuredSessions !== '' ? configuredSessions : home === undefined ? '' : join(home, 'sessions')
  if (sessionsBase === '') {
    return { ok: false, reason: 'sessionsRoot is not configured and no DSH home could be resolved' }
  }
  const sessionsRoot = resolve(sessionsBase)

  const trashBase = configuredTrash !== '' ? configuredTrash : join(dirname(sessionsRoot), 'session-trash')
  const trashRoot = resolve(trashBase)

  if (!areRootsDisjoint(sessionsRoot, trashRoot)) {
    return { ok: false, reason: 'sessionsRoot and trashRoot must be different directories that do not contain each other' }
  }

  const retentionDays = readCount(config.retentionDays, DEFAULTS.retentionDays)
  const maxTrashEntries = readCount(config.maxTrashEntries, DEFAULTS.maxTrashEntries)

  return {
    ok: true,
    settings: Object.freeze({
      sessionsRoot,
      trashRoot,
      retentionDays,
      sweepOnStart: config.sweepOnStart === undefined ? DEFAULTS.sweepOnStart : config.sweepOnStart !== false,
      maxTrashEntries: maxTrashEntries === 0 ? Number.POSITIVE_INFINITY : maxTrashEntries,
    }),
  }
}
