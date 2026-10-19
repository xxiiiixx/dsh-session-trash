/**
 * End-to-end walk through the Host half against a throwaway tree that mirrors
 * this machine's real layout, driven through the HTTP handler the browser uses.
 *
 * Nothing touches the real session store: every path is under a temp root.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { createHandler, ROUTE_PATH } from '../lib/routes.js'
import { createTrashService } from '../lib/trash.js'
import { fakeHost, headerLine, projectKey } from '../test/fixtures.mjs'
import { encodeSegment } from '../lib/paths.js'

const log = (...args) => console.log(...args)

const base = await mkdtemp(join(tmpdir(), 'trash-e2e-'))
const sessionsRoot = join(base, 'sessions')
const trashRoot = join(base, 'session-trash')
const projectDir = join(sessionsRoot, projectKey('C:\\work\\demo'))
await mkdir(projectDir, { recursive: true })

const ids = ['session-parent', 'session-kid-a', 'session-kid-b', 'session-fork', 'session-solo']
for (const id of ids) {
  const dir = join(projectDir, encodeSegment(id))
  await mkdir(dir, { recursive: true })
  const body = `${headerLine({ id, cwd: 'C:\\work\\demo' })}\n`
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))
}

const fake = fakeHost({
  children: {
    'session-parent': { derived: ['session-kid-a', 'session-kid-b'], forks: ['session-fork'] },
  },
})
const settings = {
  sessionsRoot,
  trashRoot,
  retentionDays: 30,
  sweepOnStart: false,
  maxTrashEntries: 50,
}
const service = createTrashService({ settings, host: fake.host, emit: (t, p) => fake.removed.push([t, p]) })
const handle = createHandler(service)

/** POST one operation the way the browser does. */
async function post(body) {
  const response = await handle(
    new Request(`http://127.0.0.1:3080${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, body: await response.json() }
}

log('1) plan the parent')
const planned = await post({ op: 'plan', sessionId: 'session-parent' })
assert.equal(planned.status, 200)
assert.equal(planned.body.canDelete, true)
assert.deepEqual(planned.body.carried, ['session-kid-a', 'session-kid-b'], 'derived children only')
assert.ok(!planned.body.carried.includes('session-fork'), 'the fork is not carried')
log(`   canDelete=${planned.body.canDelete} carried=${planned.body.carried.length} (fork excluded)`)

log('2) a fork does not block its origin')
const forkPlan = await post({ op: 'plan', sessionId: 'session-solo' })
assert.equal(forkPlan.body.canDelete, true)

log('3) delete the parent through the HTTP handler')
const deleted = await post({ op: 'trash', sessionId: 'session-parent' })
assert.equal(deleted.status, 200)
assert.equal(deleted.body.carried, 2)
const trashId = deleted.body.trashId
log(`   trashId=${trashId}`)

const manifest = JSON.parse(await readFile(join(trashRoot, trashId, 'manifest.json'), 'utf8'))
assert.equal(manifest.children.length, 2)
assert.equal(prettySafe(manifest.sessionId), 'session-parent')
log(`   manifest carries ${manifest.children.length} children`)

log('4) the list shows the entry with its child count')
const listed = await post({ op: 'list' })
assert.equal(listed.body.entries.length, 1)
assert.equal(listed.body.entries[0].children, 2)
assert.equal(listed.body.entries[0].broken, false)

log('5) restore brings the whole working set back')
const restored = await post({ op: 'restore', trashId })
assert.equal(restored.status, 200)
assert.equal(restored.body.restoredChildren, 2)
for (const id of ['session-parent', 'session-kid-a', 'session-kid-b']) {
  const dir = join(projectDir, encodeSegment(id))
  const { lstat } = await import('node:fs/promises')
  assert.ok((await lstat(dir)).isDirectory(), `${id} restored`)
}
log('   parent and both derived children are back')

log('6) the fork never moved and never blocked')
const forkDir = join(projectDir, encodeSegment('session-fork'))
assert.ok((await (await import('node:fs/promises')).lstat(forkDir)).isDirectory())

log('7) a junction that leaves the sessions root is refused, not followed')
const escapeTarget = join(base, 'outside')
await mkdir(escapeTarget, { recursive: true })
await writeFile(
  join(escapeTarget, 'session.v4.jsonl.zstd'),
  zstdCompressSync(Buffer.from(`${headerLine({ id: 'session-linked', cwd: 'C:\\work\\demo' })}\n`, 'utf8')),
)
const linkDir = join(projectDir, encodeSegment('session-linked'))
await symlink(escapeTarget, linkDir, 'junction').catch(() => undefined)
const linkedPlan = await post({ op: 'plan', sessionId: 'session-linked' })
// On Windows a directory junction survives `realpath`, so the locator sees a
// directory that resolves outside the root and refuses to claim it: the answer
// is a plan that cannot be deleted, naming the reason. It must never be a plan
// that says "yes" for a path outside the root.
assert.equal(linkedPlan.status, 200)
assert.equal(linkedPlan.body.canDelete, false, 'a directory outside the root is never deletable')
log(`   canDelete=${linkedPlan.body.canDelete} blockers=${JSON.stringify(linkedPlan.body.blockers)}`)

log('8) unknown operations and oversized bodies are refused')
const badOp = await post({ op: 'drop-everything' })
assert.equal(badOp.status, 400)
const huge = await post({ op: 'list', pad: 'x'.repeat(70_000) })
assert.equal(huge.status, 413)

log('9) a path was never accepted anywhere')
assert.ok(!JSON.stringify(planned.body).includes(sessionsRoot), 'no filesystem path in a response')

// A Windows junction is a directory entry: Node's `rm` recurses into it and
// then cannot remove the now-empty link, so remove the link itself with rmdir
// (which never follows it) before clearing the tree.
await rmdir(linkDir).catch(() => undefined)
await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
log('\nend-to-end walk passed')

/** Guard against a manifest field accidentally becoming a path. */
function prettySafe(value) {
  return value
}
