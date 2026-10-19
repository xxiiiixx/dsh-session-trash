/**
 * Report what the *current source* decides for every real session on this
 * machine. Read-only: it never moves anything, it only asks `plan`.
 *
 *   node scripts/audit.mjs
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveSettings } from '../lib/config.js'
import { createTrashService } from '../lib/trash.js'

const resolved = resolveSettings({})
if (!resolved.ok) {
  console.error('unavailable:', resolved.reason)
  process.exit(2)
}
const settings = resolved.settings

// A fresh process reads the module now on disk, which is the point: this shows
// what the code says today, independent of what a long-running Host has cached.
const service = createTrashService({
  settings,
  host: {
    // No live registry here: an Agent that this process cannot see cannot be
    // running in it. The Host's own view is what the dialog queries at runtime.
    agents: { get: () => undefined },
    sessionPersistence: { list: async () => [] },
    sessionQuery: { readTitle: async () => undefined },
  },
  emit: () => undefined,
})

const projects = await readdir(settings.sessionsRoot, { withFileTypes: true })
const rows = []
for (const project of projects) {
  if (!project.isDirectory()) continue
  const dirs = await readdir(join(settings.sessionsRoot, project.name), { withFileTypes: true })
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const sessionId = dir.name
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
      rows.push({ sessionId, project: project.name, outcome: 'skipped (name is not a plain id)' })
      continue
    }
    try {
      const plan = await service.plan(sessionId)
      rows.push({
        sessionId,
        project: project.name,
        outcome: plan.canDelete ? 'deletable' : 'blocked',
        blockers: plan.blockers,
        files: plan.files,
        bytes: plan.bytes,
      })
    } catch (error) {
      rows.push({ sessionId, project: project.name, outcome: `refused: ${error.code}`, detail: error.message })
    }
  }
}

const deletable = rows.filter((row) => row.outcome === 'deletable')
const blocked = rows.filter((row) => row.outcome === 'blocked')
const other = rows.filter((row) => row.outcome !== 'deletable' && row.outcome !== 'blocked')

console.log(`sessions examined : ${rows.length}`)
console.log(`deletable         : ${deletable.length}`)
console.log(`blocked           : ${blocked.length}`)
console.log(`other             : ${other.length}`)
for (const row of blocked) console.log('  BLOCKED', row.sessionId, JSON.stringify(row.blockers))
for (const row of other) console.log('  OTHER  ', row.sessionId, row.outcome, row.detail ?? '')
