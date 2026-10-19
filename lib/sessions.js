/**
 * Read-only session inspection.
 *
 * Everything here is non-destructive by construction: it locates a session's
 * directory, proves the directory really is that session, and collects the
 * reasons a deletion must be refused. `trash.js` runs this same code again
 * immediately before it moves anything, which is what keeps the confirmation
 * dialog's verdict and the actual move consistent.
 */

import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'

import { encodeSegment, isInside, isSafeId } from './paths.js'

/** Current generation file, plus the retired generations a directory may hold. */
const LOG_FILE = /^session(\.v\d+)?\.jsonl(\.zstd)?$/

/** How much of a header line we are willing to buffer before giving up. */
const MAX_HEADER_BYTES = 64 * 1024

/** A refusal reason, kept as a stable code the client translates. */
export const BLOCKER = Object.freeze({
  live: 'live',
  hasChildren: 'has-children',
  notFound: 'not-found',
  foreign: 'foreign-session',
  symlink: 'symlink',
  outside: 'outside-root',
})

/**
 * List the log artifacts of one session directory, newest generation first.
 * @param {string} dir - the session directory.
 * @returns {Promise<string[]>} absolute file paths, best candidate first.
 */
async function listLogFiles(dir) {
  const names = await readdir(dir)
  return names
    .filter((name) => LOG_FILE.test(name))
    .sort((left, right) => generationOf(right) - generationOf(left))
    .map((name) => join(dir, name))
}

/**
 * Numeric generation of one log file name (`session.v4.jsonl.zstd` → 4).
 * @param {string} name - file name.
 * @returns {number} generation, 0 for the unreleased `session.jsonl` form.
 */
function generationOf(name) {
  const match = /^session\.v(\d+)\.jsonl/.exec(name)
  return match === null ? 0 : Number(match[1])
}

/**
 * Read the first non-empty line of a plain JSONL file without loading it all.
 * @param {string} path - file path.
 * @returns {Promise<string | undefined>} the first line, or undefined.
 */
async function firstPlainLine(path) {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 16 * 1024 })
  let buffered = ''
  try {
    for await (const chunk of stream) {
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline >= 0) return buffered.slice(0, newline)
      if (buffered.length > MAX_HEADER_BYTES) return undefined
    }
    return buffered.length > 0 ? buffered : undefined
  } finally {
    stream.destroy()
  }
}

/**
 * Read the first line of a Zstandard-compressed JSONL file.
 *
 * The log is a concatenation of independent frames, so the header alone is one
 * frame; decompressing the whole file to read one line would be wasteful on a
 * long session, and the stream is destroyed as soon as the first line is in
 * hand.
 *
 * @param {string} path - file path.
 * @returns {Promise<string | undefined>} the first line, or undefined.
 */
async function firstZstdLine(path) {
  const source = createReadStream(path, { highWaterMark: 16 * 1024 })
  const decoder = createZstdDecompress()
  source.pipe(decoder)
  let buffered = ''
  try {
    for await (const chunk of decoder) {
      buffered += chunk.toString('utf8')
      const newline = buffered.indexOf('\n')
      if (newline >= 0) return buffered.slice(0, newline)
      if (buffered.length > MAX_HEADER_BYTES) return undefined
    }
    return buffered.length > 0 ? buffered : undefined
  } finally {
    decoder.destroy()
    source.destroy()
  }
}

/**
 * Read and validate the stored header of one session directory.
 *
 * @param {string} dir - the session directory.
 * @returns {Promise<{ id: string, cwd: string | undefined, createdAt: number | undefined } | undefined>}
 *   the header when a log was found and parsed, otherwise undefined.
 */
export async function readSessionHeader(dir) {
  const files = await listLogFiles(dir)
  if (files.length === 0) return undefined
  const file = files[0]
  const line = file.endsWith('.zstd') ? await firstZstdLine(file) : await firstPlainLine(file)
  if (line === undefined) return undefined
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  if (parsed.type !== 'session' || typeof parsed.id !== 'string') return undefined
  return {
    id: parsed.id,
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : undefined,
  }
}

/**
 * Locate one session's directory under the sessions root.
 *
 * The backend stores each session as `<root>/<projectKey(cwd)>/<encoded id>/`.
 * Rather than re-implementing `projectKey` (a lossy, bounded transform we would
 * have to keep in lockstep with the backend), this scans the single directory
 * level holding project folders and matches the encoded id — the id encoding is
 * injective and is the only part we must get right.
 *
 * This is *location only*. The returned directory is a candidate, not proof:
 * every caller re-reads its header and refuses a directory that belongs to a
 * different session.
 *
 * @param {string} sessionsRoot - resolved sessions root.
 * @param {string} sessionId - validated session id.
 * @returns {Promise<{ dir: string, projectDir: string, projectDirName: string } | undefined>}
 *   the located directory, or undefined when no directory matches.
 */
export async function findSessionDir(sessionsRoot, sessionId) {
  if (!isSafeId(sessionId)) return undefined
  const segment = encodeSegment(sessionId)
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(sessionsRoot, project.name)
    let info
    try {
      info = await lstat(join(projectDir, segment))
    } catch {
      continue
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    const resolvedProject = await realpath(projectDir).catch(() => undefined)
    const resolvedCandidate = await realpath(join(projectDir, segment)).catch(() => undefined)
    if (resolvedProject === undefined || resolvedCandidate === undefined) continue
    if (!isInside(resolvedProject, resolvedCandidate) || !isInside(sessionsRoot, resolvedCandidate)) continue
    return { dir: resolvedCandidate, projectDir: resolvedProject, projectDirName: project.name }
  }
  return undefined
}

/**
 * Collect every reason this session must not be deleted right now.
 *
 * @param {object} deps - optional host services; any may be undefined.
 * @param {{ agents?: { get(id: string): unknown }, sessions?: { get(id: string): unknown },
 *           sessionPersistence?: { list(): Promise<{ header: { parentSession?: string } }[]> } }} deps
 * @param {string} sessionId - validated session id.
 * @returns {Promise<string[]>} stable blocker codes; empty when deletion may proceed.
 */
export async function collectBlockers(deps, sessionId) {
  const blockers = []
  if (deps.agents?.get(sessionId) !== undefined) blockers.push(BLOCKER.live)
  else if (deps.sessions?.get(sessionId) !== undefined) blockers.push(BLOCKER.live)

  const persistence = deps.sessionPersistence
  if (persistence !== undefined && typeof persistence.list === 'function') {
    try {
      const snapshots = await persistence.list()
      for (const snapshot of snapshots) {
        if (snapshot?.header?.parentSession === sessionId) {
          blockers.push(BLOCKER.hasChildren)
          break
        }
      }
    } catch {
      // A listing failure must not become permission to delete a parent whose
      // children we simply could not enumerate: treat it as a refusal.
      blockers.push(BLOCKER.hasChildren)
    }
  }
  return blockers
}

/**
 * Measure one session directory (file count and total bytes).
 *
 * @param {string} dir - the session directory.
 * @returns {Promise<{ files: number, bytes: number }>} the measurement.
 */
export async function measureDir(dir) {
  let files = 0
  let bytes = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile()) continue
    files += 1
    const info = await lstat(join(dir, entry.name)).catch(() => undefined)
    if (info !== undefined) bytes += info.size
  }
  return { files, bytes }
}
