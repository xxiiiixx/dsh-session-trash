/** The wire contract: one route, one body shape, stable codes, no path argument. */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_BODY_BYTES, ROUTE_PATH, createHandler, registerRoute } from '../lib/routes.js'
import { CODE, TrashError } from '../lib/trash.js'

/** Build a POST request with a JSON body. */
function post(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Request(`http://127.0.0.1:3080${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: text,
  })
}

/** A service that records the operation it was asked for. */
function recordingService() {
  const calls = []
  return {
    calls,
    plan: async (id) => {
      calls.push(['plan', id])
      return { ok: true, sessionId: id }
    },
    trash: async (id) => {
      calls.push(['trash', id])
      return { ok: true, trashId: 'entry' }
    },
    forget: async (id) => {
      calls.push(['forget', id])
      return { ok: true, trashId: null }
    },
    list: async () => {
      calls.push(['list'])
      return []
    },
    restore: async (id) => {
      calls.push(['restore', id])
      throw new TrashError(CODE.alreadyExists, 'already there')
    },
    purge: async (id) => {
      calls.push(['purge', id])
      return { ok: true }
    },
    purgeAll: async () => {
      calls.push(['purgeAll'])
      return { ok: true, removed: 0 }
    },
  }
}

test('the route path is the one the client resolves', () => {
  assert.equal(ROUTE_PATH, '/api/session-trash')
})

test('a legal operation reaches the service and answers JSON', async () => {
  const service = recordingService()
  const response = await createHandler(service)(post({ op: 'plan', sessionId: 'session-a' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  assert.deepEqual(await response.json(), { ok: true, sessionId: 'session-a' })
  assert.deepEqual(service.calls, [['plan', 'session-a']])
})

test('every operation is reachable and list/purgeAll take no identifier', async () => {
  const service = recordingService()
  const handle = createHandler(service)
  assert.equal((await handle(post({ op: 'list' }))).status, 200)
  assert.equal((await handle(post({ op: 'purgeAll' }))).status, 200)
  assert.equal((await handle(post({ op: 'forget', sessionId: 'session-ghost' }))).status, 200)
  assert.equal((await handle(post({ op: 'purge', trashId: 'entry' }))).status, 200)
  for (const [name, id] of [
    ['plan', 'session-a'],
    ['trash', 'session-a'],
    ['purge', 'entry'],
  ]) {
    assert.equal((await handle(post({ op: name, sessionId: id, trashId: id }))).status, 200)
  }
  assert.deepEqual(
    service.calls.map(([name]) => name),
    ['list', 'purgeAll', 'forget', 'purge', 'plan', 'trash', 'purge'],
  )
})

test('a stable failure code maps to its status', async () => {
  const service = recordingService()
  const response = await createHandler(service)(post({ op: 'restore', trashId: 'entry' }))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { ok: false, code: CODE.alreadyExists, message: 'already there' })
})

test('an unconfigured plugin answers unavailable instead of crashing', async () => {
  const response = await createHandler(undefined)(post({ op: 'list' }))
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, CODE.unavailable)
})

test('only POST is accepted', async () => {
  const handle = createHandler(recordingService())
  const get = new Request(`http://127.0.0.1:3080${ROUTE_PATH}`, { method: 'GET' })
  const response = await handle(get)
  assert.equal(response.status, 405)
})

test('a body over the ceiling is refused before parsing', async () => {
  const handle = createHandler(recordingService())
  const oversized = 'x'.repeat(MAX_BODY_BYTES + 1)
  const response = await handle(post({ op: 'plan', sessionId: 'a', pad: oversized }))
  assert.equal(response.status, 413)
})

test('malformed bodies and unknown operations are bad requests', async () => {
  const handle = createHandler(recordingService())
  for (const body of ['{not json', '[]', '"text"', 'null', '{}', '{"op":"nope"}', '{"op":42}']) {
    const response = await handle(post(body))
    assert.equal(response.status, 400, `expected 400 for ${body}`)
    assert.equal((await response.json()).code, CODE.badRequest)
  }
})

test('a missing identifier is a bad request and never reaches the service', async () => {
  const service = recordingService()
  const handle = createHandler(service)
  for (const body of [{ op: 'plan' }, { op: 'trash', sessionId: '' }, { op: 'purge', trashId: 42 }]) {
    const response = await handle(post(body))
    assert.equal(response.status, 400)
  }
  assert.deepEqual(service.calls, [])
})

test('an unexpected service error is reported without leaking a stack or a path', async () => {
  const handle = createHandler({
    ...recordingService(),
    plan: async () => {
      throw new Error('boom at C:\\secret\\path.js:1')
    },
  })
  const response = await handle(post({ op: 'plan', sessionId: 'session-a' }))
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.code, CODE.badRequest)
  assert.doesNotMatch(body.message, /secret|\.js:1|boom/)
})

test('the route registers on the authenticated fetch channel exactly once', async () => {
  const registered = []
  let disposed = false
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          registered.push(route)
          return async () => {
            disposed = true
          }
        },
      },
    },
  }
  const dispose = await registerRoute(ctx, createHandler(recordingService()))
  assert.equal(registered.length, 1)
  assert.equal(registered[0].path, ROUTE_PATH)
  assert.deepEqual(registered[0].methods, ['POST'])
  assert.equal(registered[0].requestBody, 'buffered')
  assert.equal(typeof registered[0].fetch, 'function')
  assert.equal(disposed, false)
  await dispose()
  assert.equal(disposed, true)
})
