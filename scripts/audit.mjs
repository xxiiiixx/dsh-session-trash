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
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

import { resolveSettings } from '../lib/config.js'
import { createTrashService } from '../lib/trash.js'

const resolved = resolveSettings({})
if (!resolved.ok) {
  console.error('unavailable:', resolved.reason)
  process.exit(2)
}
const settings = resolved.settings

const LOG = /^session(\.v\d+)?\.jsonl(\.zstd)?$/
const projects = await readdir(settings.sessionsRoot, { withFileTypes: true })
const ids = []
const headers = []

// Walk the tree directly. Going through the plugin's own locator here would beg
// the question: a locator bug would silently drop sessions from the audit, which
// is exactly how an earlier version of this script reported "0 parents".
for (const project of projects) {
  if (!project.isDirectory()) continue
  const dirs = await readdir(join(settings.sessionsRoot, project.name), { withFileTypes: true })
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const sessionDir = join(settings.sessionsRoot, project.name, dir.name)
    const files = (await readdir(sessionDir, { withFileTypes: true })).filter((f) => f.isFile() && LOG.test(f.name))
    if (files.length === 0) {
      ids.push({ id: dir.name, note: 'no log file' })
      continue
    }
    const file = join(sessionDir, files[0].name)
    try {
      const raw = readFileSync(file)
      const text = files[0].name.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
      const header = JSON.parse(text.split('\n')[0])
      headers.push(header)
      ids.push({ id: header.id ?? dir.name })
    } catch {
      ids.push({ id: dir.name, note: 'header unreadable' })
    }
  }
}

const parents = new Set(headers.map((h) => h.parentSession).filter(Boolean))
const subagents = headers.filter((h) => h.origin === 'subagent').length

const service = createTrashService({
  settings,
  host: {
    // This process owns no live Agent, so no session in it can be mid-turn; the
    // Host's own registry is what the dialog queries at runtime.
    agents: { get: () => undefined },
    sessionPersistence: { list: async () => headers.map((header) => ({ header })) },
    sessionQuery: { readTitle: async () => undefined },
  },
  emit: () => undefined,
})

const rows = []
for (const entry of ids) {
  if (entry.note !== undefined) {
    rows.push({ id: entry.id, outcome: `skipped (${entry.note})` })
    continue
  }
  try {
    const plan = await service.plan(entry.id)
    rows.push({ id: entry.id, outcome: plan.canDelete ? 'deletable' : 'blocked', blockers: plan.blockers })
  } catch (error) {
    rows.push({ id: entry.id, outcome: `refused: ${error.code}`, detail: error.message })
  }
}

const blocked = rows.filter((row) => row.outcome === 'blocked')
const other = rows.filter((row) => row.outcome !== 'deletable' && row.outcome !== 'blocked')

console.log(`sessions examined   : ${rows.length}`)
console.log(`subagent sessions   : ${subagents}`)
console.log(`sessions with child : ${parents.size}`)
console.log(`deletable           : ${rows.filter((row) => row.outcome === 'deletable').length}`)
console.log(`blocked             : ${blocked.length}`)
console.log(`other               : ${other.length}`)
for (const row of blocked) console.log('  BLOCKED', row.id, JSON.stringify(row.blockers))
for (const row of other) console.log('  OTHER  ', row.id, row.outcome, row.detail ?? '')
