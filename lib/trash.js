/**
 * The one destructive module.
 *
 * Every other file in this plugin is read-only or plumbing. This module moves
 * directories and deletes them, so its rules are stated once, here, and every
 * entry point repeats them in the same order:
 *
 *   1. validate the identifier (structure only — never a path);
 *   2. resolve the real directory and prove it is inside the configured root;
 *   3. re-collect blockers (live agent, child sessions) at the moment of use;
 *   4. move with `rename` only — never copy-then-delete, which would leave a
 *      half-deleted session across a volume boundary;
 *   5. record what happened in the entry's manifest before reporting success.
 *
 * Failures are values (`TrashError` with a stable `code`), never thrown half-way
 * states: a rename that fails leaves both directories exactly as they were.
 */

import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { encodeSegment, isInside, isSafeId, isSafeSegment, joinSegment } from './paths.js'
import { BLOCKER, collectBlockers, findSessionDir, measureDir, readSessionHeader } from './sessions.js'

/** Stable failure codes; the client maps each one to a sentence. */
export const CODE = Object.freeze({
  badRequest: 'bad-request',
  invalidId: 'invalid-id',
  notFound: 'not-found',
  live: 'live',
  hasChildren: 'has-children',
  alreadyExists: 'already-exists',
  outsideRoot: 'outside-root',
  foreignSession: 'foreign-session',
  crossVolume: 'cross-volume',
  busy: 'busy',
  tooMany: 'too-many',
  corrupt: 'corrupt',
  unavailable: 'unavailable',
})

/** One failed operation with a code the client can render. */
export class TrashError extends Error {
  /**
   * @param {string} code - one of {@link CODE}.
   * @param {string} message - operator-facing detail (never rendered raw to a user alone).
   */
  constructor(code, message) {
    super(message)
    this.name = 'TrashError'
    this.code = code
  }
}

/** Manifest file name inside one trash entry. */
const MANIFEST = 'manifest.json'

/** Manifest schema version. */
const MANIFEST_VERSION = 1

/** Directory inside an entry that holds the moved session directory. */
const SESSION = 'session'

/**
 * Map a filesystem failure onto a stable code.
 * @param {unknown} error - the thrown value.
 * @returns {TrashError} the mapped failure.
 */
function mapFsError(error) {
  const code = typeof error === 'object' && error !== null ? String(error.code ?? '') : ''
  if (code === 'EXDEV') return new TrashError(CODE.crossVolume, 'the trash root is on a different volume than the session')
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENOTEMPTY') {
    return new TrashError(CODE.busy, 'the session directory is in use by another process')
  }
  if (code === 'ENOENT') return new TrashError(CODE.notFound, 'the path no longer exists')
  return new TrashError(CODE.badRequest, error instanceof Error ? error.message : String(error))
}

/**
 * Whether a path exists (any type).
 * @param {string} path - absolute path.
 * @returns {Promise<boolean>} true when something is there.
 */
async function exists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Build the sortable entry name for one deleted session. */
function entryName(sessionId, now) {
  const stamp = now.toISOString().replace(/[-:.]/g, '')
  return `${stamp}-${encodeSegment(sessionId)}`
}

/** Serialise every mutating operation; concurrent clicks must not interleave. */
let chain = Promise.resolve()

/**
 * Run one operation after every previously queued mutation settles.
 * @template T
 * @param {() => Promise<T>} operation - the work.
 * @returns {Promise<T>} the operation's result.
 */
function serialized(operation) {
  const run = chain.then(operation, operation)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Create the trash service over one resolved settings record.
 *
 * @param {object} options - wiring.
 * @param {Readonly<Record<string, unknown>>} options.settings - from `resolveSettings`.
 * @param {object} options.host - optional host services (`agents`, `sessions`, `sessionPersistence`, `sessionQuery`, `workspaceRegistry`).
 * @param {(type: string, payload: unknown) => void} [options.emit] - forwards `api-session/removed`.
 * @param {() => Date} [options.clock] - time source (tests override it).
 * @param {(from: string, to: string) => Promise<void>} [options.renameImpl] - the move
 *   primitive; tests inject one that fails, which is the only way to exercise the
 *   cross-volume path without a second volume.
 * @returns {object} the service.
 */
export function createTrashService({ settings, host, emit, clock = () => new Date(), renameImpl = rename }) {
  const sessionsRoot = /** @type {string} */ (settings.sessionsRoot)
  const trashRoot = /** @type {string} */ (settings.trashRoot)
  const retentionDays = /** @type {number} */ (settings.retentionDays)
  const maxEntries = /** @type {number} */ (settings.maxTrashEntries)

  /** Log a non-fatal side effect failure without failing the operation. */
  const warn = (what, error) => {
    console.warn(`[dsh-session-trash] ${what}:`, error instanceof Error ? error.message : error)
  }

  /**
   * Resolve a session id to its real directory, or undefined when absent.
   * @param {string} sessionId - validated id.
   */
  async function locate(sessionId) {
    if (!isSafeId(sessionId)) throw new TrashError(CODE.invalidId, `invalid session id: ${String(sessionId)}`)
    const found = await findSessionDir(sessionsRoot, sessionId)
    if (found === undefined) return undefined
    if (!isInside(sessionsRoot, found.dir)) {
      throw new TrashError(CODE.outsideRoot, 'the session directory resolved outside the sessions root')
    }
    return found
  }

  /**
   * Current title for a session id (best effort).
   * @param {string} sessionId - validated id.
   * @returns {Promise<string>} the title, falling back to the id.
   */
  async function titleOf(sessionId) {
    const query = host.sessionQuery
    if (query !== undefined && typeof query.readTitle === 'function') {
      try {
        const snapshot = await query.readTitle(sessionId)
        const title = snapshot?.title
        if (typeof title === 'string' && title !== '') return title
      } catch {
        // Title is cosmetic; a failure must not fail the operation.
      }
    }
    return sessionId
  }

  /**
   * List the entry directories present in the trash.
   * @returns {Promise<string[]>} absolute entry directories, newest name first.
   */
  async function entryDirs() {
    let names
    try {
      names = await readdir(trashRoot, { withFileTypes: true })
    } catch (error) {
      if (/** @type {{code?: string}} */ (error).code === 'ENOENT') return []
      throw mapFsError(error)
    }
    return names
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .map((name) => join(trashRoot, name))
  }

  /**
   * Resolve one trash id to its entry directory, refusing anything that is not
   * a direct child of the trash root.
   * @param {string} trashId - entry directory name.
   * @returns {Promise<{ dir: string, manifest: Record<string, unknown> }>} the entry.
   */
  async function readEntry(trashId) {
    if (!isSafeId(trashId)) throw new TrashError(CODE.invalidId, `invalid trash id: ${String(trashId)}`)
    const dir = join(trashRoot, trashId)
    if (!isInside(trashRoot, dir)) throw new TrashError(CODE.outsideRoot, 'the entry is outside the trash root')
    const info = await lstat(dir).catch(() => undefined)
    if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
      throw new TrashError(CODE.notFound, 'no such trash entry')
    }
    let manifest
    try {
      manifest = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8'))
    } catch {
      throw new TrashError(CODE.corrupt, 'the entry manifest is missing or unreadable')
    }
    if (manifest === null || typeof manifest !== 'object' || manifest.version !== MANIFEST_VERSION) {
      throw new TrashError(CODE.corrupt, 'the entry manifest has an unsupported shape')
    }
    return { dir, manifest }
  }

  /**
   * The read-only preflight shown by the confirmation dialog and repeated by
   * every mutation.
   *
   * @param {string} sessionId - validated id.
   * @returns {Promise<Record<string, unknown>>} the plan.
   */
  async function plan(sessionId) {
    if (!isSafeId(sessionId)) throw new TrashError(CODE.invalidId, `invalid session id: ${String(sessionId)}`)
    const found = await locate(sessionId)
    const blockers = await collectBlockers(host, sessionId)
    const title = await titleOf(sessionId)

    if (found === undefined) {
      // No directory: the session exists only as a live or remembered record
      // that never materialized. Deleting it means forgetting the record, not
      // moving files, and blockers still decide whether that is allowed.
      const known = host.agents?.get(sessionId) !== undefined || host.sessions?.get(sessionId) !== undefined
      return {
        ok: true,
        sessionId,
        title,
        cwd: undefined,
        projectDirName: undefined,
        materialized: false,
        files: 0,
        bytes: 0,
        known,
        blockers: known ? blockers : [BLOCKER.notFound],
        canDelete: known && blockers.length === 0,
      }
    }

    const header = await readSessionHeader(found.dir)
    if (header === undefined || header.id !== sessionId) {
      const foreign = new TrashError(CODE.foreignSession, 'the directory does not belong to the requested session')
      throw foreign
    }
    const measured = await measureDir(found.dir)
    return {
      ok: true,
      sessionId,
      title,
      cwd: header.cwd,
      projectDirName: found.projectDirName,
      materialized: true,
      files: measured.files,
      bytes: measured.bytes,
      known: true,
      blockers,
      canDelete: blockers.length === 0,
    }
  }

  /**
   * Move one session directory into the trash.
   *
   * @param {string} sessionId - validated id.
   * @returns {Promise<{ ok: true, trashId: string }>} the created entry.
   */
  async function trash(sessionId) {
    return serialized(async () => {
      if (!isSafeId(sessionId)) throw new TrashError(CODE.invalidId, `invalid session id: ${String(sessionId)}`)

      const existing = await entryDirs()
      if (existing.length >= maxEntries) {
        throw new TrashError(CODE.tooMany, 'the trash is full; purge entries before deleting more sessions')
      }

      const found = await locate(sessionId)
      if (found === undefined) {
        // Nothing on disk: never invent an entry, just forget the reference.
        return forgetNow(sessionId)
      }

      const blockers = await collectBlockers(host, sessionId)
      if (blockers.includes(BLOCKER.live)) throw new TrashError(CODE.live, 'the session is still running')
      if (blockers.includes(BLOCKER.hasChildren)) {
        throw new TrashError(CODE.hasChildren, 'the session has child sessions')
      }
      if (blockers.includes(BLOCKER.activityUnknown)) {
        throw new TrashError(CODE.unavailable, 'the session list could not be read, so running work cannot be ruled out')
      }
      if (blockers.length > 0) throw new TrashError(CODE.badRequest, `refused: ${blockers.join(', ')}`)

      const header = await readSessionHeader(found.dir)
      if (header === undefined || header.id !== sessionId) {
        throw new TrashError(CODE.foreignSession, 'the directory does not belong to the requested session')
      }

      const measured = await measureDir(found.dir)
      const title = await titleOf(sessionId)
      const now = clock()
      const trashId = entryName(sessionId, now)
      const entryDir = join(trashRoot, trashId)

      // The trash root is created on first use; its absence is normal, and a
      // failure here must be reported as a real filesystem problem.
      await mkdir(trashRoot, { recursive: true }).catch((error) => {
        throw mapFsError(error)
      })
      try {
        // `recursive: false` makes a name collision fail rather than reuse an
        // existing entry: two deletions must never share a directory.
        await mkdir(entryDir, { recursive: false })
      } catch (error) {
        if (/** @type {{code?: string}} */ (error).code === 'EEXIST') {
          throw new TrashError(CODE.busy, 'another deletion is creating the same trash entry')
        }
        throw mapFsError(error)
      }

      try {
        await renameImpl(found.dir, join(entryDir, SESSION))
      } catch (error) {
        // Leave nothing behind: the entry directory held no files yet.
        await rmdir(entryDir).catch(() => undefined)
        throw mapFsError(error)
      }

      const manifest = {
        version: MANIFEST_VERSION,
        sessionId,
        title,
        cwd: header.cwd ?? null,
        projectDirName: found.projectDirName,
        dirName: encodeSegment(sessionId),
        deletedAt: now.toISOString(),
        files: measured.files,
        bytes: measured.bytes,
      }
      try {
        await writeAtomic(join(entryDir, MANIFEST), JSON.stringify(manifest, null, 2))
      } catch (error) {
        // The move succeeded; a missing manifest would make the entry
        // unreadable but not unrecoverable, so put the session back and fail.
        await renameImpl(join(entryDir, SESSION), found.dir).catch(() => undefined)
        await rmdir(entryDir).catch(() => undefined)
        throw mapFsError(error)
      }

      await dropReferences(sessionId)
      return { ok: true, trashId }
    })
  }

  /**
   * Forget a session that has no directory on disk.
   * @param {string} sessionId - validated id.
   * @returns {{ ok: true, trashId: null }} resolution marker.
   */
  function forgetNow(sessionId) {
    return dropReferences(sessionId).then(() => ({ ok: true, trashId: null }))
  }

  /**
   * Remove the session from the workspace registry sets and tell the client.
   * Both are best effort: the log is already gone, and a failure here only
   * leaves a stale row that disappears on the next list refresh.
   * @param {string} sessionId - validated id.
   */
  async function dropReferences(sessionId) {
    const registry = host.workspaceRegistry
    if (registry !== undefined) {
      if (typeof registry.unpinSession === 'function') {
        await registry.unpinSession(sessionId).catch((error) => warn('unpin failed', error))
      }
      if (typeof registry.unarchiveSession === 'function') {
        await registry.unarchiveSession(sessionId).catch((error) => warn('unarchive failed', error))
      }
    }
    if (typeof emit === 'function') {
      try {
        emit('api-session/removed', sessionId)
      } catch (error) {
        warn('removal notification failed', error)
      }
    }
  }

  /**
   * Forget a session without a directory, after the same blocker check.
   * @param {string} sessionId - validated id.
   * @returns {Promise<{ ok: true, trashId: null }>} resolution marker.
   */
  async function forget(sessionId) {
    return serialized(async () => {
      if (!isSafeId(sessionId)) throw new TrashError(CODE.invalidId, `invalid session id: ${String(sessionId)}`)
      const blockers = await collectBlockers(host, sessionId)
      if (blockers.includes(BLOCKER.live)) throw new TrashError(CODE.live, 'the session is still running')
      if (blockers.includes(BLOCKER.hasChildren)) {
        throw new TrashError(CODE.hasChildren, 'the session has child sessions')
      }
      if (blockers.includes(BLOCKER.activityUnknown)) {
        throw new TrashError(CODE.unavailable, 'the session list could not be read, so running work cannot be ruled out')
      }
      const found = await locate(sessionId)
      if (found !== undefined) {
        throw new TrashError(CODE.badRequest, 'the session still has files on disk; use the trash operation')
      }
      return forgetNow(sessionId)
    })
  }

  /**
   * Every entry currently in the trash, newest first.
   * @returns {Promise<Array<Record<string, unknown>>>} entries, with `broken: true`
   *   for entries whose manifest cannot be read.
   */
  async function list() {
    const dirs = await entryDirs()
    const entries = []
    for (const dir of dirs) {
      const trashId = dir.slice(trashRoot.length).replace(/^[\\/]+/, '')
      try {
        const { manifest } = await readEntry(trashId)
        entries.push({
          trashId,
          broken: false,
          sessionId: String(manifest.sessionId ?? ''),
          title: typeof manifest.title === 'string' ? manifest.title : String(manifest.sessionId ?? ''),
          cwd: typeof manifest.cwd === 'string' ? manifest.cwd : null,
          deletedAt: typeof manifest.deletedAt === 'string' ? manifest.deletedAt : null,
          files: typeof manifest.files === 'number' ? manifest.files : 0,
          bytes: typeof manifest.bytes === 'number' ? manifest.bytes : 0,
        })
      } catch {
        entries.push({ trashId, broken: true, sessionId: '', title: trashId, cwd: null, deletedAt: null, files: 0, bytes: 0 })
      }
    }
    entries.sort((left, right) => String(right.deletedAt ?? '').localeCompare(String(left.deletedAt ?? '')))
    return entries
  }

  /**
   * Move one entry back to where the session came from.
   * @param {string} trashId - entry directory name.
   * @returns {Promise<{ ok: true, sessionId: string }>} the restored session.
   */
  async function restore(trashId) {
    return serialized(async () => {
      const { dir, manifest } = await readEntry(trashId)
      const sessionId = manifest.sessionId
      const projectDirName = manifest.projectDirName
      const dirName = manifest.dirName
      if (!isSafeId(sessionId) || !isSafeSegment(projectDirName) || !isSafeSegment(dirName)) {
        throw new TrashError(CODE.corrupt, 'the manifest holds an unusable path component')
      }
      const source = join(dir, SESSION)
      const sourceInfo = await lstat(source).catch(() => undefined)
      if (sourceInfo === undefined || !sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
        throw new TrashError(CODE.corrupt, 'the entry no longer holds its session directory')
      }
      const projectDir = joinSegment(sessionsRoot, projectDirName)
      const target = joinSegment(projectDir, dirName)
      if (!isInside(sessionsRoot, target)) throw new TrashError(CODE.outsideRoot, 'the target is outside the sessions root')
      if (await exists(target)) throw new TrashError(CODE.alreadyExists, 'a directory for this session already exists')

      await mkdir(projectDir, { recursive: true }).catch((error) => {
        throw mapFsError(error)
      })
      try {
        await renameImpl(source, target)
      } catch (error) {
        throw mapFsError(error)
      }
      await rm(join(dir, MANIFEST), { force: true }).catch((error) => warn('manifest cleanup failed', error))
      await rmdir(dir).catch(() => undefined)
      return { ok: true, sessionId }
    })
  }

  /**
   * Permanently delete one entry.
   * @param {string} trashId - entry directory name.
   * @returns {Promise<{ ok: true }>} resolution after the directory is gone.
   */
  async function purge(trashId) {
    return serialized(async () => {
      if (!isSafeId(trashId)) throw new TrashError(CODE.invalidId, `invalid trash id: ${String(trashId)}`)
      const dir = join(trashRoot, trashId)
      if (!isInside(trashRoot, dir)) throw new TrashError(CODE.outsideRoot, 'the entry is outside the trash root')
      const info = await lstat(dir).catch(() => undefined)
      if (info === undefined) throw new TrashError(CODE.notFound, 'no such trash entry')
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new TrashError(CODE.badRequest, 'the trash entry is not a directory')
      }
      await rm(dir, { recursive: true, force: false }).catch((error) => {
        throw mapFsError(error)
      })
      return { ok: true }
    })
  }

  /**
   * Permanently delete every entry.
   * @returns {Promise<{ ok: true, removed: number }>} how many entries were removed.
   */
  async function purgeAll() {
    return serialized(async () => {
      const dirs = await entryDirs()
      let removed = 0
      for (const dir of dirs) {
        try {
          await rm(dir, { recursive: true, force: false })
          removed += 1
        } catch (error) {
          warn(`failed to purge ${dir}`, error)
        }
      }
      return { ok: true, removed }
    })
  }

  /**
   * Apply the retention window. Called once at Host start; silent by design,
   * because it runs before any page is connected.
   * @param {Date} [now] - override for tests.
   * @returns {Promise<{ removed: number, failed: number }>} the sweep summary.
   */
  async function sweep(now = clock()) {
    if (retentionDays <= 0) return { removed: 0, failed: 0 }
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
    let removed = 0
    let failed = 0
    for (const dir of await entryDirs()) {
      const trashId = dir.slice(trashRoot.length).replace(/^[\\/]+/, '')
      let deletedAt
      try {
        const { manifest } = await readEntry(trashId)
        deletedAt = Date.parse(String(manifest.deletedAt ?? ''))
      } catch {
        // A broken entry is never auto-deleted: it may be the only copy of a
        // session whose manifest was damaged, and a human should decide.
        continue
      }
      if (!Number.isFinite(deletedAt) || deletedAt > cutoff) continue
      try {
        await rm(dir, { recursive: true, force: false })
        removed += 1
      } catch {
        failed += 1
      }
    }
    if (removed > 0 || failed > 0) {
      console.log(`[dsh-session-trash] retention sweep removed ${removed} entr${removed === 1 ? 'y' : 'ies'} older than ${retentionDays} days`)
    }
    return { removed, failed }
  }

  return { plan, trash, forget, list, restore, purge, purgeAll, sweep, settings }
}

/**
 * Write a file by writing a sibling and renaming over the target.
 * @param {string} path - destination.
 * @param {string} content - text.
 */
async function writeAtomic(path, content) {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}
