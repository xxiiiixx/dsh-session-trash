/**
 * Read-only smoke check against the machine's real session root.
 *
 * Not part of `npm test`: it depends on this machine's DSH home. It exists so
 * the location/header logic can be proven against genuine backend artifacts
 * rather than only against fixtures, without touching anything.
 *
 *   node scripts/smoke.mjs [sessionId]
 */

import { resolveSettings } from '../lib/config.js'
import { createTrashService } from '../lib/trash.js'

const resolved = resolveSettings({})
if (!resolved.ok) {
  console.error('unavailable:', resolved.reason)
  process.exit(2)
}
const settings = resolved.settings
console.log('sessionsRoot:', settings.sessionsRoot)
console.log('trashRoot   :', settings.trashRoot)
console.log('retention   :', settings.retentionDays, 'days')

const service = createTrashService({
  settings,
  host: {
    agents: { get: () => undefined },
    sessions: { get: () => undefined },
    sessionPersistence: { list: async () => [] },
    sessionQuery: {
      readTitle: async () => ({ title: '(smoke: title not read)' }),
    },
    workspaceRegistry: {
      unpinSession: async () => undefined,
      unarchiveSession: async () => undefined,
    },
  },
  emit: () => undefined,
})

const requested = process.argv[2]
const entries = await service.list().catch((error) => {
  console.error('list failed:', error.code, error.message)
  return []
})
console.log('trash entries:', entries.length)

if (requested === undefined) {
  // Enumerate nothing destructive: report the first session id the backend knows.
  const { readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const projects = await readdir(settings.sessionsRoot, { withFileTypes: true }).catch(() => [])
  const first = projects.find((entry) => entry.isDirectory())
  if (first === undefined) {
    console.log('no project directories found')
    process.exit(0)
  }
  const { realpath } = await import('node:fs/promises')
  const dirs = await readdir(join(settings.sessionsRoot, first.name), { withFileTypes: true })
  const session = dirs.find((entry) => entry.isDirectory())
  if (session === undefined) {
    console.log('no session directories found')
    process.exit(0)
  }
  const id = session.name
  console.log('probing session directory name:', id)
  const plan = await service.plan(id).catch(async (error) => {
    console.error('plan failed:', error.code, error.message)
    return undefined
  })
  if (plan !== undefined) {
    console.log('plan:', {
      sessionId: plan.sessionId,
      materialized: plan.materialized,
      files: plan.files,
      bytes: plan.bytes,
      cwd: plan.cwd,
      blockers: plan.blockers,
      canDelete: plan.canDelete,
    })
  }
  void realpath
  process.exit(0)
}

const plan = await service.plan(requested)
console.log('plan:', plan)
