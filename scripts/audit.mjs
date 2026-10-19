/**
 * Read-only audit of every real session, with *real* parent relationships read
 * from each log's own header — no stubs for the persistence seam.
 *
 * It answers one question: with the rules as they are on disk right now, what
 * would each session's confirmation dialog decide? Nothing is moved.
 *
 *   node scripts/audit.mjs
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveSettings } from '../lib/config.js'
import { findSessionDir, readSessionHeader } from '../lib/sessions.js'
import { createTrashService } from '../lib/trash.js'

const resolved = resolveSettings({})
if (!resolved.ok) {
  console.error('unavailable:', resolved.reason)
  process.exit(2)
}
const settings = resolved.settings

const projects = await readdir(settings.sessionsRoot, { withFileTypes: true })
const ids = []
for (const project of projects) {
  if (!project.isDirectory()) continue
  const dirs = await readdir(join(settings.sessionsRoot, project.name), { withFileTypes: true })
  for (const dir of dirs) if (dir.isDirectory()) ids.push(dir.name)
}

// Build the persistence seam's answer from the stored headers themselves, so a
// session that really is a parent is seen as one here too.
const snapshots = []
for (const id of ids) {
  const found = await findSessionDir(settings.sessionsRoot, id).catch(() => undefined)
  if (found === undefined) continue
  const header = await readSessionHeader(found.dir).catch(() => undefined)
  if (header !== undefined) snapshots.push({ header })
}
const parents = new Set(snapshots.map((entry) => entry.header.parentSession).filter(Boolean))

const service = createTrashService({
  settings,
  host: {
    // This process owns no live Agent, so no session in it can be mid-turn; the
    // Host's own registry is what the dialog queries at runtime.
    agents: { get: () => undefined },
    sessionPersistence: { list: async () => snapshots },
    sessionQuery: { readTitle: async () => undefined },
  },
  emit: () => undefined,
})

const rows = []
for (const id of ids) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    rows.push({ id, outcome: 'skipped (not a plain id)' })
    continue
  }
  try {
    const plan = await service.plan(id)
    rows.push({ id, outcome: plan.canDelete ? 'deletable' : 'blocked', blockers: plan.blockers })
  } catch (error) {
    rows.push({ id, outcome: `refused: ${error.code}`, detail: error.message })
  }
}

const blocked = rows.filter((row) => row.outcome === 'blocked')
const other = rows.filter((row) => row.outcome !== 'deletable' && row.outcome !== 'blocked')

console.log(`sessions examined   : ${rows.length}`)
console.log(`distinct parents    : ${parents.size}`)
console.log(`deletable           : ${rows.filter((row) => row.outcome === 'deletable').length}`)
console.log(`blocked             : ${blocked.length}`)
console.log(`other               : ${other.length}`)
for (const row of blocked) console.log('  BLOCKED', row.id, JSON.stringify(row.blockers))
for (const row of other) console.log('  OTHER  ', row.id, row.outcome, row.detail ?? '')
