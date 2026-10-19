/**
 * Path and identifier safety — the whole security surface of this plugin.
 *
 * Every destructive operation in `trash.js` starts here. Nothing else in the
 * plugin is allowed to build a filesystem path from a client-supplied string,
 * and no request ever carries a path: the client sends a session id or a trash
 * entry id, and this module is what turns either one into something that is
 * provably inside a configured root.
 *
 * The encoding mirrors the JSONL session backend's own `encodeSegment`, so a
 * session id maps to exactly the directory name that backend already used. We
 * duplicate the function instead of importing it: the backend exports neither
 * it nor its `projectKey` sibling, and copying these 15 lines is far cheaper
 * than coupling to a private module of a package that changes with the harness.
 */

import { isAbsolute, join, relative, sep } from 'node:path'

/** Longest identifier we accept, matching a comfortable filesystem segment. */
export const MAX_ID_LENGTH = 200

/** Safe identifier characters: what `encodeSegment` leaves untouched. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/

/**
 * Safe *segment* characters, which additionally allow the `~XXXX` escape
 * produced by {@link encodeSegment}. Session and project directory names are
 * already encoded, so they legitimately contain `~`.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]+$/

/**
 * Encode an arbitrary string as one safe path segment.
 *
 * Identical in behaviour to the session backend's `encodeSegment`: safe code
 * units pass through, every other UTF-16 unit (including `~`) becomes `~XXXX`,
 * and `.` / `..` are escaped so a whole segment can never traverse.
 *
 * @param {string} raw - the string to encode; must be non-empty.
 * @returns {string} the escaped single path segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('cannot encode an empty path segment')
  }
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) out += char
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Whether a client-supplied identifier is structurally safe to use.
 *
 * This is a cheap first gate, not the last one: callers still resolve the real
 * path and assert containment before touching anything.
 *
 * @param {unknown} value - candidate identifier.
 * @returns {boolean} true when it is a plausible session or trash id.
 */
export function isSafeId(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_ID_LENGTH) return false
  if (value === '.' || value === '..') return false
  return SAFE_ID.test(value)
}

/**
 * Assert that `target` is a strict descendant of `root`.
 *
 * @param {string} root - absolute, already resolved root directory.
 * @param {string} target - absolute, already resolved candidate.
 * @returns {boolean} true only when the relative step stays inside.
 */
export function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const step = relative(root, target)
  if (step === '') return false
  if (isAbsolute(step)) return false
  if (step === '..' || step.startsWith(`..${sep}`)) return false
  return true
}

/**
 * Assert that one directory is not the other and neither contains the other.
 *
 * @param {string} left - absolute path.
 * @param {string} right - absolute path.
 * @returns {boolean} true when the two roots are usable together.
 */
export function areRootsDisjoint(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left === '' || right === '') return false
  if (left === right) return false
  return !isInside(left, right) && !isInside(right, left)
}

/**
 * Whether a directory name the plugin itself wrote is a single safe component.
 *
 * Unlike {@link isSafeId} this accepts `~`, because the recorded component is
 * already encoded (`encodeSegment` output), and those escapes are exactly the
 * characters that make an id unusable as an id in the first place.
 *
 * @param {unknown} value - candidate segment.
 * @returns {boolean} true when it is one resolvable directory name.
 */
export function isSafeSegment(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_ID_LENGTH) return false
  if (value === '.' || value === '..') return false
  return SAFE_SEGMENT.test(value)
}

/**
 * Assert that a directory name is a single safe component and join it onto a
 * root — the only sanctioned way to append a recorded name to a root.
 *
 * @param {string} root - absolute root.
 * @param {string} segment - one directory name.
 * @returns {string} the joined absolute path.
 * @throws {Error} when the segment is not a single safe component.
 */
export function joinSegment(root, segment) {
  if (!isSafeSegment(segment)) throw new Error(`unsafe path segment: ${String(segment)}`)
  return join(root, segment)
}
