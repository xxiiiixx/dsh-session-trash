/**
 * The single HTTP endpoint.
 *
 * One route, one method, one shape: `POST /api/session-trash` with a JSON body
 * naming an operation. The endpoint carries **no path argument anywhere** — the
 * only identifiers that cross the wire are a session id and a trash entry id,
 * and `trash.js` resolves both against its own configured roots. That is the
 * property that makes this file safe to read quickly.
 *
 * Registration goes through `connection.fetch`, which puts the route behind the
 * same Host/Origin and browser-credential fence every first-party API uses, so
 * the handler only ever sees an already-admitted request.
 */

import { CODE, TrashError } from './trash.js'

/** Route path; the client resolves the same string relative to its page base. */
export const ROUTE_PATH = '/api/session-trash'

/** Largest accepted request body. Every legal request is a few hundred bytes. */
export const MAX_BODY_BYTES = 64 * 1024

/** Operations the endpoint accepts. */
const OPERATIONS = new Set(['plan', 'trash', 'forget', 'list', 'restore', 'purge', 'purgeAll'])

/** HTTP status per stable failure code. */
const STATUS = Object.freeze({
  [CODE.badRequest]: 400,
  [CODE.invalidId]: 400,
  [CODE.notFound]: 404,
  [CODE.live]: 409,
  [CODE.hasChildren]: 409,
  [CODE.alreadyExists]: 409,
  [CODE.crossVolume]: 409,
  [CODE.busy]: 409,
  [CODE.tooMany]: 409,
  [CODE.outsideRoot]: 400,
  [CODE.foreignSession]: 409,
  [CODE.corrupt]: 409,
  [CODE.unavailable]: 503,
})

/** JSON response with the no-store policy this endpoint always wants. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** A failure in the wire shape the client renders. */
function failure(code, message, status = STATUS[code] ?? 500) {
  return json({ ok: false, code, message }, status)
}

/**
 * Read a request body with an enforced byte ceiling.
 * @param {Request} request - the incoming request.
 * @param {number} limit - maximum bytes.
 * @returns {Promise<string | undefined>} the text, or undefined when too large.
 */
async function readBounded(request, limit) {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > limit) return undefined
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

/** One identified value, or a stable `bad-request` for the caller. */
function requireId(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new WireError(CODE.badRequest, `${label} must be a non-empty string`)
  }
  return value
}

/**
 * A failure raised while validating the request rather than performing it.
 * Declared before first use so the module's evaluation order stays obvious.
 */
class WireError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * Build the route handler over one trash service.
 *
 * @param {{ plan: Function, trash: Function, forget: Function, list: Function,
 *           restore: Function, purge: Function, purgeAll: Function } | undefined} service
 *   the service, or undefined when the plugin could not configure itself.
 * @returns {(request: Request) => Promise<Response>} the handler.
 */
export function createHandler(service) {
  return async function handle(request) {
    if (request.method !== 'POST') return failure(CODE.badRequest, 'only POST is accepted', 405)
    if (service === undefined) return failure(CODE.unavailable, 'session trash is not configured')

    const text = await readBounded(request, MAX_BODY_BYTES)
    if (text === undefined) return failure(CODE.badRequest, 'the request body is too large', 413)

    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      return failure(CODE.badRequest, 'the request body is not JSON')
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return failure(CODE.badRequest, 'the request body must be a JSON object')
    }
    const op = payload.op
    if (typeof op !== 'string' || !OPERATIONS.has(op)) {
      return failure(CODE.badRequest, `unknown operation: ${String(op)}`)
    }

    try {
      switch (op) {
        case 'plan':
          return json(await service.plan(requireId(payload.sessionId, 'sessionId')))
        case 'trash':
          return json(await service.trash(requireId(payload.sessionId, 'sessionId')))
        case 'forget':
          return json(await service.forget(requireId(payload.sessionId, 'sessionId')))
        case 'list':
          return json({ ok: true, entries: await service.list() })
        case 'restore':
          return json(await service.restore(requireId(payload.trashId, 'trashId')))
        case 'purge':
          return json(await service.purge(requireId(payload.trashId, 'trashId')))
        case 'purgeAll':
          return json(await service.purgeAll())
        default:
          return failure(CODE.badRequest, `unknown operation: ${op}`)
      }
    } catch (error) {
      if (error instanceof TrashError) return failure(error.code, error.message)
      if (error instanceof WireError) return failure(error.code, error.message)
      // An unexpected failure is logged with its stack for the operator and
      // answered with a fixed sentence: filesystem paths must not travel to a
      // client that only ever sent an identifier.
      console.error('[dsh-session-trash] request failed:', error)
      return failure(CODE.badRequest, 'the operation failed; see the Host log for details')
    }
  }
}

/**
 * Register the route on the Host's authenticated fetch channel.
 *
 * @param {{ connection: { fetch: { register(route: object): () => Promise<void> } } }} ctx
 *   the plugin context.
 * @param {(request: Request) => Promise<Response>} handle - from {@link createHandler}.
 * @returns {Promise<void>} resolution of the route registration.
 */
export function registerRoute(ctx, handle) {
  return ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: handle,
  })
}
