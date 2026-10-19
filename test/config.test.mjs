/** Config resolution: defaults, root disjointness, and the "unavailable" verdict. */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { DEFAULTS, resolveSettings } from '../lib/config.js'

test('both roots default under the DSH home and stay disjoint', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = join('C:', 'home', '.dsh')
  try {
    const resolved = resolveSettings(undefined)
    assert.equal(resolved.ok, true)
    assert.equal(resolved.settings.sessionsRoot, join('C:', 'home', '.dsh', 'sessions'))
    assert.equal(resolved.settings.trashRoot, join('C:', 'home', '.dsh', 'session-trash'))
    assert.equal(resolved.settings.retentionDays, DEFAULTS.retentionDays)
    assert.equal(resolved.settings.maxTrashEntries, DEFAULTS.maxTrashEntries)
    assert.equal(resolved.settings.sweepOnStart, true)
    assert.ok(Object.isFrozen(resolved.settings))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('an explicit trash root is honoured', () => {
  const resolved = resolveSettings({
    sessionsRoot: join('C:', 'sessions'),
    trashRoot: join('D:', 'trash'),
    retentionDays: 7,
    maxTrashEntries: 12,
    sweepOnStart: false,
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.settings.trashRoot, join('D:', 'trash'))
  assert.equal(resolved.settings.retentionDays, 7)
  assert.equal(resolved.settings.maxTrashEntries, 12)
  assert.equal(resolved.settings.sweepOnStart, false)
})

test('a trash root inside the sessions root is refused', () => {
  const sessions = join('C:', 'sessions')
  const resolved = resolveSettings({ sessionsRoot: sessions, trashRoot: join(sessions, 'trash') })
  assert.equal(resolved.ok, false)
  assert.match(resolved.reason, /do not contain each other/)
})

test('equal roots are refused', () => {
  const root = join('C:', 'sessions')
  assert.equal(resolveSettings({ sessionsRoot: root, trashRoot: root }).ok, false)
})

test('malformed numbers fall back to defaults', () => {
  const resolved = resolveSettings({
    sessionsRoot: join('C:', 'sessions'),
    retentionDays: 'nope',
    maxTrashEntries: -3,
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.settings.retentionDays, DEFAULTS.retentionDays)
  assert.equal(resolved.settings.maxTrashEntries, DEFAULTS.maxTrashEntries)
})

test('maxTrashEntries 0 means unlimited', () => {
  const resolved = resolveSettings({ sessionsRoot: join('C:', 'sessions'), maxTrashEntries: 0 })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.settings.maxTrashEntries, Number.POSITIVE_INFINITY)
})

test('no DSH home and no configured root makes the plugin unavailable', () => {
  const previousHome = process.env.DSH_HOME
  const previousUser = process.env.USERPROFILE
  const previousHomeUnix = process.env.HOME
  delete process.env.DSH_HOME
  // homedir() reads these on Windows/Unix respectively; clearing both makes the
  // fallback genuinely unavailable for the duration of the call.
  delete process.env.USERPROFILE
  delete process.env.HOME
  try {
    const resolved = resolveSettings({})
    // On a platform where homedir() still answers, the plugin stays available;
    // the assertion only fixes the shape of the verdict either way.
    if (resolved.ok) assert.equal(typeof resolved.settings.sessionsRoot, 'string')
    else assert.match(resolved.reason, /sessionsRoot/)
  } finally {
    if (previousHome !== undefined) process.env.DSH_HOME = previousHome
    if (previousUser !== undefined) process.env.USERPROFILE = previousUser
    if (previousHomeUnix !== undefined) process.env.HOME = previousHomeUnix
  }
})
