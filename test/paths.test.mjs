/** Path and identifier safety — the gate every destructive operation leans on. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join, sep } from 'node:path'

import {
  MAX_ID_LENGTH,
  areRootsDisjoint,
  encodeSegment,
  isInside,
  isSafeId,
  isSafeSegment,
  joinSegment,
} from '../lib/paths.js'

test('encodeSegment leaves safe characters alone', () => {
  assert.equal(encodeSegment('session-0123-ab_cd'), 'session-0123-ab_cd')
})

test('encodeSegment escapes traversal and separators', () => {
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('a\\b'), 'a~005Cb')
  assert.equal(encodeSegment('C:'), 'C~003A')
  assert.equal(encodeSegment('~'), '~007E')
})

test('encodeSegment escapes non-ASCII code unit by code unit', () => {
  // 新 = U+65B0, 建 = U+5EFA — one escape per UTF-16 unit, uppercase hex.
  assert.equal(encodeSegment('新建'), '~65B0~5EFA')
})

test('encodeSegment rejects an empty string', () => {
  assert.throws(() => encodeSegment(''), /empty path segment/)
  assert.throws(() => encodeSegment(undefined), /empty path segment/)
})

test('isSafeId accepts ordinary session and entry ids', () => {
  assert.equal(isSafeId('session-05c18c8c-73ea-4329-ae1c-3dc87b151417'), true)
  assert.equal(isSafeId('20261019T173000000Z-session-abc'), true)
  assert.equal(isSafeId('a_b.c-d'), true)
})

test('isSafeId rejects traversal, separators and junk', () => {
  for (const value of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a b', 'a~b', 'x\u0000y', null, undefined, 42]) {
    assert.equal(isSafeId(value), false, `expected ${JSON.stringify(value)} to be rejected`)
  }
  assert.equal(isSafeId('a'.repeat(MAX_ID_LENGTH + 1)), false)
  assert.equal(isSafeId('a'.repeat(MAX_ID_LENGTH)), true)
})

test('isSafeSegment accepts encoded directory names but not ids with separators', () => {
  assert.equal(isSafeSegment('~65B0~5EFA'), true)
  assert.equal(isSafeSegment('--C-Users-x--'), true)
  assert.equal(isSafeSegment('a/b'), false)
  assert.equal(isSafeSegment('..'), false)
  assert.equal(isSafeSegment(''), false)
})

test('joinSegment refuses anything but one safe component', () => {
  assert.equal(joinSegment('/root', 'abc'), join('/root', 'abc'))
  assert.throws(() => joinSegment('/root', '../abc'), /unsafe path segment/)
  assert.throws(() => joinSegment('/root', 'a/b'), /unsafe path segment/)
})

test('isInside accepts strict descendants only', () => {
  const root = join(sep, 'root')
  assert.equal(isInside(root, join(root, 'a')), true)
  assert.equal(isInside(root, join(root, 'a', 'b')), true)
  assert.equal(isInside(root, root), false)
  assert.equal(isInside(root, join(root, '..', 'etc')), false)
  assert.equal(isInside(root, join(sep, 'root2')), false)
  assert.equal(isInside(root, join(root, '..')), false)
})

test('areRootsDisjoint rejects equal and nested roots', () => {
  const root = join(sep, 'root')
  assert.equal(areRootsDisjoint(root, join(sep, 'trash')), true)
  assert.equal(areRootsDisjoint(root, root), false)
  assert.equal(areRootsDisjoint(root, join(root, 'trash')), false)
  assert.equal(areRootsDisjoint(join(root, 'trash'), root), false)
  assert.equal(areRootsDisjoint('', join(sep, 'trash')), false)
})
