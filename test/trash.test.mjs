/** The destructive module's contract: refuse first, mutate atomically, never copy. */

import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { encodeSegment } from '../lib/paths.js'
import { CODE, createTrashService } from '../lib/trash.js'
import { fakeHost, headerLine, makeRoot, projectKey } from './fixtures.mjs'

/** Build a service over one fixture root. */
async function makeService(input = {}) {
  const fixture = await makeRoot(input.rootInput)
  const fake = fakeHost(input.hostInput)
  const settings = {
    sessionsRoot: fixture.root,
    trashRoot: input.trashRoot ?? join(fixture.root, '..', 'session-trash'),
    retentionDays: input.retentionDays ?? 30,
    sweepOnStart: true,
    maxTrashEntries: input.maxTrashEntries ?? 500,
  }
  const service = createTrashService({
    settings,
    host: fake.host,
    emit: (type, payload) => fake.removed.push([type, payload]),
    clock: input.clock,
  })
  return { fixture, fake, service, settings }
}

test('plan is read-only and reports size and title', async () => {
  const { fixture, service } = await makeService({ rootInput: { sessions: [{ id: 'session-a' }] } })
  try {
    const before = await readdir(join(fixture.root, projectKey('C:\\work\\demo'), encodeSegment('session-a')))
    const result = await service.plan('session-a')
    assert.equal(result.ok, true)
    assert.equal(result.sessionId, 'session-a')
    assert.equal(result.materialized, true)
    assert.equal(result.title, 'Title of session-a')
    assert.equal(result.files, 1)
    assert.ok(result.bytes > 0)
    assert.deepEqual(result.blockers, [])
    assert.equal(result.canDelete, true)
    const after = await readdir(join(fixture.root, projectKey('C:\\work\\demo'), encodeSegment('session-a')))
    assert.deepEqual(after, before)
  } finally {
    await fixture.dispose()
  }
})

test('plan rejects a malformed id and a directory owned by another session', async () => {
  const { fixture, service } = await makeService({ rootInput: { sessions: [{ id: 'session-a' }] } })
  try {
    await assert.rejects(() => service.plan('../etc'), (error) => error.code === CODE.invalidId)

    // A directory whose name matches the session but whose log header names a
    // different one must never be moved.
    const projectDir = join(fixture.root, projectKey('C:\\work\\demo'))
    const sessionDir = join(projectDir, encodeSegment('session-a'))
    const forged = `${headerLine({ id: 'session-other' })}\n`
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(forged, 'utf8')))
    await assert.rejects(() => service.plan('session-a'), (error) => error.code === CODE.foreignSession)
  } finally {
    await fixture.dispose()
  }
})

test('plan refuses a running session and a parent with children', async () => {
  const { fixture, service } = await makeService({
    rootInput: { sessions: [{ id: 'session-run' }, { id: 'session-parent' }] },
    hostInput: { running: ['session-run'], children: { 'session-parent': ['session-child'] } },
  })
  try {
    const live = await service.plan('session-run')
    assert.ok(live.blockers.includes('live'))
    assert.equal(live.canDelete, false)
    const parent = await service.plan('session-parent')
    assert.ok(parent.blockers.includes('has-children'))
    assert.equal(parent.canDelete, false)
  } finally {
    await fixture.dispose()
  }
})

test('plan allows an idle Agent that merely stays resident', async () => {
  // The reported failure: an already-stopped session was refused because its
  // Agent object still existed. Only `status === 'running'` may block a delete.
  const { fixture, service } = await makeService({
    rootInput: { sessions: [{ id: 'session-idle' }] },
    hostInput: { idleAgents: ['session-idle'] },
  })
  try {
    const plan = await service.plan('session-idle')
    assert.deepEqual(plan.blockers, [])
    assert.equal(plan.canDelete, true)
    const result = await service.trash('session-idle')
    assert.equal(result.ok, true)
  } finally {
    await fixture.dispose()
  }
})

test('an Agent surface without a status is treated as running', async () => {
  const { fixture, service } = await makeService({ rootInput: { sessions: [{ id: 'session-a' }] } })
  try {
    // An opaque Agent cannot be proven idle, so the plugin refuses rather than
    // guessing its way into moving a log that may still be written.
    const opaque = createTrashService({
      settings: service.settings,
      host: {
        agents: { get: () => ({ id: 'session-a' }) },
        sessionPersistence: { list: async () => [] },
        sessionQuery: { readTitle: async () => ({ title: 't' }) },
      },
      emit: () => undefined,
    })
    await assert.rejects(() => opaque.trash('session-a'), (error) => error.code === CODE.live)
  } finally {
    await fixture.dispose()
  }
})

test('trash moves the directory, writes a manifest, and notifies the client', async () => {
  const { fixture, fake, service, settings } = await makeService({
    rootInput: { sessions: [{ id: 'session-a' }] },
  })
  try {
    const result = await service.trash('session-a')
    assert.equal(result.ok, true)
    assert.equal(typeof result.trashId, 'string')

    const original = join(fixture.root, projectKey('C:\\work\\demo'), encodeSegment('session-a'))
    await assert.rejects(() => lstat(original), (error) => error.code === 'ENOENT')

    const entryDir = join(settings.trashRoot, result.trashId)
    const manifest = JSON.parse(await readFile(join(entryDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.version, 1)
    assert.equal(manifest.sessionId, 'session-a')
    assert.equal(manifest.title, 'Title of session-a')
    assert.equal(manifest.cwd, 'C:\\work\\demo')
    assert.equal(manifest.projectDirName, projectKey('C:\\work\\demo'))
    assert.equal(manifest.dirName, encodeSegment('session-a'))
    assert.ok((await lstat(join(entryDir, 'session'))).isDirectory())

    assert.deepEqual(fake.removed, [['api-session/removed', 'session-a']])
    assert.deepEqual(
      fake.host.workspaceRegistry.calls.map(([name]) => name).sort(),
      ['unarchive', 'unpin'],
    )
  } finally {
    await fixture.dispose()
  }
})

test('trash refuses a running session and a parent, leaving the directory untouched', async () => {
  const { fixture, service } = await makeService({
    rootInput: { sessions: [{ id: 'session-run' }, { id: 'session-parent' }] },
    hostInput: { running: ['session-run'], children: { 'session-parent': ['session-child'] } },
  })
  try {
    await assert.rejects(() => service.trash('session-run'), (error) => error.code === CODE.live)
    await assert.rejects(() => service.trash('session-parent'), (error) => error.code === CODE.hasChildren)
    for (const id of ['session-run', 'session-parent']) {
      const dir = join(fixture.root, projectKey('C:\\work\\demo'), encodeSegment(id))
      assert.ok((await lstat(dir)).isDirectory(), `${id} must still be on disk`)
    }
  } finally {
    await fixture.dispose()
  }
})

test('trash is atomic on a rename failure and never falls back to a copy', async () => {
  const { fixture, service, settings } = await makeService({ rootInput: { sessions: [{ id: 'session-a' }] } })
  try {
    // Simulate a cross-volume move: the real `rename` refuses, and the service
    // must report it rather than copying (a copy would leave a duplicate, or a
    // half-deleted session after an interruption).
    const service2 = createTrashService({
      settings,
      host: fakeHost().host,
      emit: () => undefined,
      renameImpl: async () => {
        const error = new Error('cross-device link not permitted')
        error.code = 'EXDEV'
        throw error
      },
    })
    await assert.rejects(() => service2.trash('session-a'), (error) => error.code === CODE.crossVolume)

    const original = join(fixture.root, projectKey('C:\\work\\demo'), encodeSegment('session-a'))
    assert.ok((await lstat(original)).isDirectory(), 'the session must be back where it was')
    const entries = await readdir(settings.trashRoot).catch(() => [])
    assert.deepEqual(entries, [], 'no half-made entry may survive a failed move')
    await service.plan('session-a')
  } finally {
    await fixture.dispose()
  }
})

test('list, restore and purge round-trip an entry', async () => {
  const { fixture, service, settings } = await makeService({ rootInput: { sessions: [{ id: 'session-a' }] } })
  try {
    const { trashId } = await service.trash('session-a')

    const listed = await service.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].trashId, trashId)
    assert.equal(listed[0].sessionId, 'session-a')
    assert.equal(listed[0].broken, false)
    assert.equal(typeof listed[0].deletedAt, 'string')

    const restored = await service.restore(trashId)
    assert.equal(restored.ok, true)
    assert.equal(restored.sessionId, 'session-a')
    const original = join(fixture.root, projectKey('C:\\work\\demo'), encodeSegment('session-a'))
    assert.ok((await lstat(original)).isDirectory())
    assert.deepEqual(await readdir(join(settings.trashRoot, trashId)).catch(() => ['gone']), ['gone'])

    const again = await service.trash('session-a')
    assert.equal((await service.purge(again.trashId)).ok, true)
    assert.deepEqual(await service.list(), [])
    await assert.rejects(() => service.purge(again.trashId), (error) => error.code === CODE.notFound)
  } finally {
    await fixture.dispose()
  }
})

test('restore refuses to overwrite a session directory that reappeared', async () => {
  const { fixture, service } = await makeService({ rootInput: { sessions: [{ id: 'session-a' }] } })
  try {
    const { trashId } = await service.trash('session-a')
    const target = join(fixture.root, projectKey('C:\\work\\demo'), encodeSegment('session-a'))
    await mkdir(target, { recursive: true })
    await assert.rejects(() => service.restore(trashId), (error) => error.code === CODE.alreadyExists)
    // The entry must survive a refused restore.
    assert.equal((await service.list())[0].trashId, trashId)
  } finally {
    await fixture.dispose()
  }
})

test('purge and purgeAll never leave the trash root', async () => {
  const { fixture, service } = await makeService({
    rootInput: { sessions: [{ id: 'session-a' }, { id: 'session-b' }] },
  })
  try {
    for (const bad of ['../../etc', '..', 'a/b', '']) {
      await assert.rejects(() => service.purge(bad), (error) => error.code === CODE.invalidId)
    }
    await service.trash('session-a')
    await service.trash('session-b')
    const result = await service.purgeAll()
    assert.equal(result.removed, 2)
    assert.deepEqual(await service.list(), [])
    // The sessions root itself is untouched by a purge.
    assert.ok((await lstat(fixture.root)).isDirectory())
  } finally {
    await fixture.dispose()
  }
})

test('a corrupt manifest is listed as broken and never auto-deleted', async () => {
  const { fixture, service, settings } = await makeService({ rootInput: { sessions: [{ id: 'session-a' }] } })
  try {
    const { trashId } = await service.trash('session-a')
    await writeFile(join(settings.trashRoot, trashId, 'manifest.json'), '{not json', 'utf8')
    const listed = await service.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].broken, true)
    assert.equal(listed[0].trashId, trashId)
    await assert.rejects(() => service.restore(trashId), (error) => error.code === CODE.corrupt)
    // Older than any retention window, yet still not swept: a broken entry is a
    // human decision, not a scheduled deletion.
    await service.sweep(new Date('2030-01-01T00:00:00.000Z'))
    assert.equal((await service.list()).length, 1)
  } finally {
    await fixture.dispose()
  }
})

test('forget removes only a session with no directory on disk', async () => {
  const { fixture, fake, service } = await makeService({ rootInput: { sessions: [{ id: 'session-a' }] } })
  try {
    await assert.rejects(() => service.forget('session-a'), (error) => error.code === CODE.badRequest)
    const result = await service.forget('session-ghost')
    assert.equal(result.ok, true)
    assert.equal(result.trashId, null)
    assert.deepEqual(fake.removed, [['api-session/removed', 'session-ghost']])
  } finally {
    await fixture.dispose()
  }
})

test('the retention sweep removes only entries past the window', async () => {
  const clockNow = new Date('2026-10-19T00:00:00.000Z')
  const { fixture, service, settings } = await makeService({
    rootInput: { sessions: [{ id: 'session-old' }, { id: 'session-new' }] },
    retentionDays: 30,
  })
  try {
    const old = await service.trash('session-old')
    // Age one entry by rewriting its manifest timestamp.
    const manifestPath = join(settings.trashRoot, old.trashId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.deletedAt = '2026-01-01T00:00:00.000Z'
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
    await service.trash('session-new')

    const swept = await service.sweep(clockNow)
    assert.equal(swept.removed, 1)
    const remaining = await service.list()
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].sessionId, 'session-new')
  } finally {
    await fixture.dispose()
  }
})

test('a full trash refuses new deletions', async () => {
  const { fixture, service } = await makeService({
    rootInput: { sessions: [{ id: 'session-a' }, { id: 'session-b' }] },
    maxTrashEntries: 1,
  })
  try {
    await service.trash('session-a')
    await assert.rejects(() => service.trash('session-b'), (error) => error.code === CODE.tooMany)
    const still = join(fixture.root, projectKey('C:\\work\\demo'), encodeSegment('session-b'))
    assert.ok((await lstat(still)).isDirectory())
  } finally {
    await fixture.dispose()
  }
})

test('concurrent deletions are serialized', async () => {
  const { fixture, service } = await makeService({
    rootInput: { sessions: [{ id: 'session-a' }, { id: 'session-b' }] },
  })
  try {
    const [first, second] = await Promise.allSettled([service.trash('session-a'), service.trash('session-b')])
    assert.equal(first.status, 'fulfilled')
    assert.equal(second.status, 'fulfilled')
    assert.equal((await service.list()).length, 2)
  } finally {
    await fixture.dispose()
  }
})
