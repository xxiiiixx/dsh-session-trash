/** Helpers shared by the trash tests: a throwaway sessions root with real logs. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { encodeSegment } from '../lib/paths.js'

/**
 * Encode a project path the way the JSONL backend's (unexported) `projectKey`
 * does. Tests reproduce it so the fixture root looks exactly like a real one.
 * @param {string} cwd - absolute project directory.
 * @returns {string} the project directory name.
 */
export function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Header line the JSONL backend writes first. */
export function headerLine({ id, cwd, createdAt = 1_700_000_000_000, agentPreset = 'standard' }) {
  return JSON.stringify({
    type: 'session',
    version: 4,
    id,
    createdAt,
    ...(cwd === undefined ? {} : { cwd }),
    isSeeded: false,
    delegationDepth: 0,
    ...(agentPreset === undefined ? {} : { agentPreset }),
  })
}

/**
 * Create a fixture root holding one project directory and any number of
 * sessions, each with a real one-frame Zstandard log.
 *
 * @param {{ sessions?: Array<{ id: string, cwd?: string, extraEvents?: string[] }>, projectDirName?: string }} input
 * @returns {Promise<{ root: string, dispose(): Promise<void> }>} the fixture.
 */
export async function makeRoot(input = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-session-trash-'))
  const root = join(base, 'sessions')
  await mkdir(root, { recursive: true })
  const cwd = input.sessions?.[0]?.cwd ?? 'C:\\work\\demo'
  const projectDirName = input.projectDirName ?? projectKey(cwd)
  const projectDir = join(root, projectDirName)
  await mkdir(projectDir, { recursive: true })
  for (const session of input.sessions ?? []) {
    const dir = join(projectDir, encodeSegment(session.id))
    await mkdir(dir, { recursive: true })
    const lines = [headerLine({ id: session.id, cwd: session.cwd ?? cwd }), ...(session.extraEvents ?? [])]
    const body = `${lines.join('\n')}\n`
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))
  }
  return {
    root,
    dispose: () => rm(base, { recursive: true, force: true }),
  }
}

/**
 * Minimal fake host services for the trash service.
 *
 * `running` sessions report `status: 'running'` (a turn in flight); every other
 * id is absent from the registry. `idleAgents` adds ids whose Agent is resident
 * but idle — the case that used to be refused and must now be deletable.
 *
 * `children` states lineage explicitly so the derived-vs-fork distinction is
 * testable. The terse `{ parent: [child, ...] }` form means "derived subagent
 * sessions"; `{ parent: { derived: [...], forks: [...] } }` states both.
 *
 * @param {{ running?: string[], idleAgents?: string[], children?: Record<string, string[] | { derived?: string[], forks?: string[] }> }} input
 * @returns {object} the fake host.
 */
export function fakeHost(input = {}) {
  const running = new Set(input.running ?? [])
  const idle = new Set(input.idleAgents ?? [])
  const children = input.children ?? {}
  const removed = []
  const summaries = []
  for (const [parent, spec] of Object.entries(children)) {
    const derived = Array.isArray(spec) ? spec : (spec.derived ?? [])
    const forks = Array.isArray(spec) ? [] : (spec.forks ?? [])
    for (const kid of derived) summaries.push({ header: { id: kid, parentSession: parent, origin: 'subagent' } })
    for (const kid of forks) summaries.push({ header: { id: kid, parentSession: parent, isSeeded: true } })
  }
  return {
    removed,
    summaries,
    host: {
      agents: {
        get: (id) => (running.has(id) ? { id, status: 'running' } : idle.has(id) ? { id, status: 'idle' } : undefined),
      },
      sessions: { get: () => undefined },
      sessionPersistence: { list: async () => summaries },
      sessionQuery: {
        readTitle: async (id) => ({ title: `Title of ${id}` }),
      },
      workspaceRegistry: {
        calls: [],
        unpinSession: async function unpin(sessionId) {
          this.calls.push(['unpin', sessionId])
        },
        unarchiveSession: async function unarchive(sessionId) {
          this.calls.push(['unarchive', sessionId])
        },
      },
    },
  }
}
