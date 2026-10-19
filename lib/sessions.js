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
  /**
   * A derived subagent session of this one is still inside a turn. Deleting the
   * parent would strand work that is actively running, so it is refused and the
   * dialog names the child.
   */
  childRunning: 'child-running',
  notFound: 'not-found',
  foreign: 'foreign-session',
  symlink: 'symlink',
  outside: 'outside-root',
  /**
   * The child-session question could not be answered. Kept separate from
   * `has-children` on purpose: a session is not a parent just because the
   * persistence layer refused to enumerate it, and telling a user "this session
   * has child sessions" when the listing merely failed is a wrong diagnosis.
   */
  activityUnknown: 'activity-unknown',
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
    parentSession: typeof parsed.parentSession === 'string' ? parsed.parentSession : undefined,
    origin: parsed.origin === 'subagent' ? 'subagent' : undefined,
    isSeeded: parsed.isSeeded === true,
    delegationDepth: typeof parsed.delegationDepth === 'number' ? parsed.delegationDepth : 0,
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
 * Liveness is decided the same way the shipped archive action decides it: only
 * an Agent whose `status` is `running` (a turn in flight, including one waiting
 * for an approval or an answer) counts. An idle Agent that merely stays resident
 * in the registry is *not* running — a session you stopped is stoppable, and
 * refusing it made the trash unusable for exactly the sessions people delete.
 *
 * `sessions.get()` is deliberately not consulted: it answers "is this Session
 * attached to the process", which is true for almost every row in the sidebar
 * and says nothing about whether work is happening.
 *
 * @param {object} deps - optional host services; any may be undefined.
 * @param {{ agents?: { get(id: string): { status?: string } | undefined },
 *           sessionPersistence?: { list(): Promise<{ header: { parentSession?: string } }[]> } }} deps
 * @param {string} sessionId - validated session id.
 * @returns {Promise<string[]>} stable blocker codes; empty when deletion may proceed.
 */
export async function collectBlockers(deps, sessionId) {
  const blockers = []
  if (agentIsRunning(deps, sessionId)) blockers.push(BLOCKER.live)

  const persistence = deps.sessionPersistence
  if (persistence !== undefined && typeof persistence.list === 'function') {
    try {
      const snapshots = await persistence.list()
      for (const snapshot of snapshots) {
        const header = snapshot?.header
        if (header?.parentSession !== sessionId) continue
        // A fork is a session seeded from another one but standing on its own:
        // it keeps its inherited history and is nobody's disposable work. Only a
        // derived subagent session travels with its parent.
        const derived = header.origin === 'subagent'
        if (!derived) continue
        if (agentIsRunning(deps, header.id)) {
          blockers.push(BLOCKER.childRunning)
          continue
        }
        // A subagent that itself has children cannot be carried without them;
        // carrying a whole subtree silently is not something this plugin does.
        if (hasDerivedChild(snapshots, header.id)) blockers.push(BLOCKER.hasChildren)
      }
    } catch {
      // A listing failure still refuses the delete — permission to remove a
      // parent must not be inferred from an unanswerable question — but it says
      // so, instead of claiming children that were never observed.
      blockers.push(BLOCKER.activityUnknown)
    }
  }
  return [...new Set(blockers)]
}

/**
 * Whether any snapshot is a derived subagent session of `sessionId`.
 * @param {readonly { header: { parentSession?: string, origin?: string } }[]} snapshots - corpus.
 * @param {string} sessionId - candidate parent.
 * @returns {boolean} true when a derived child exists.
 */
function hasDerivedChild(snapshots, sessionId) {
  return snapshots.some((snapshot) => {
    const header = snapshot?.header
    return header?.parentSession === sessionId && header.origin === 'subagent'
  })
}

/**
 * The derived subagent sessions that must travel with a parent.
 *
 * Forks are excluded on purpose: a session seeded from this one owns its own
 * history and keeps working after the parent is gone, so deleting the parent
 * must not drag it along. A derived subagent, by contrast, only exists to carry
 * out work for the parent.
 *
 * @param {readonly { header: { id: string, parentSession?: string, origin?: string } }[]} snapshots
 *   the session corpus.
 * @param {string} sessionId - the parent being deleted.
 * @returns {string[]} ids of the derived children, in corpus order.
 */
export function derivedChildrenOf(snapshots, sessionId) {
  const children = []
  for (const snapshot of snapshots) {
    const header = snapshot?.header
    if (header?.parentSession !== sessionId) continue
    if (header.origin !== 'subagent') continue
    if (typeof header.id !== 'string' || header.id === '') continue
    children.push(header.id)
  }
  return children
}

/**
 * Whether the session's Agent is inside a turn right now.
 *
 * An Agent surface without a `status` cannot be proven idle, so it is treated as
 * running: the plugin refuses rather than guessing its way into moving a log
 * that is being written.
 *
 * @param {{ agents?: { get(id: string): { status?: string } | undefined } }} deps - host services.
 * @param {string} sessionId - validated session id.
 * @returns {boolean} true only when the Agent reports `running`.
 */
export function agentIsRunning(deps, sessionId) {
  const agent = deps.agents?.get(sessionId)
  if (agent === undefined || agent === null) return false
  return agent.status === undefined ? true : agent.status === 'running'
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
