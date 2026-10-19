/**
 * The Client bundle's structural contract.
 *
 * These are not render tests — there is no DOM here. They assert the wiring
 * facts that broke in practice: the stylesheet must be installed for the whole
 * run (not by one component), the menu row must use the host's class names, and
 * no component may reach for `document.body`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('the stylesheet is injected on activation, not by a component', () => {
  // Regression: `<Style />` rendered only by the dialog left the menu row
  // unstyled — it appeared as the browser's default grey button.
  assert.match(SOURCE, /function installStyle\(ctx\)/, 'installStyle must exist')
  assert.match(SOURCE, /apply\(ctx\)\s*\{\s*installStyle\(ctx\)/, 'apply must install the stylesheet first')
  assert.doesNotMatch(SOURCE, /h\(Style\)/, 'no component may render its own <Style />')
  assert.doesNotMatch(SOURCE, /function Style\(\)/, 'the per-component Style component must be gone')
})

test('the stylesheet is owned by an effect, so unload removes it', () => {
  const start = SOURCE.indexOf('function installStyle(ctx)')
  const body = SOURCE.slice(start, start + 700)
  assert.match(body, /ctx\.effect\(/, 'installStyle must use ctx.effect')
  assert.match(body, /element\.remove\(\)/, 'the effect must remove the element')
  assert.match(body, /document\.head\.append/, 'the element belongs in <head>')
})

test('the menu row uses the host menu-item class names', () => {
  const start = SOURCE.indexOf('function TrashMenuButton')
  const body = SOURCE.slice(start, start + 900)
  assert.match(body, /className: 'st-menuitem-wrap'/, 'native wrapper cell')
  assert.match(body, /className: 'st-menuitem'/, 'native row geometry')
  assert.match(body, /className: 'st-menuitem-icon'/, 'native icon cell')
  assert.match(body, /className: 'st-menuitem-label'/, 'native ellipsised label')
  assert.match(body, /role: 'menuitem'/, 'menu semantics')
  assert.match(body, /'data-danger': 'true'/, 'danger colouring stays on')
})

test('every class the components use is defined in the stylesheet', () => {
  const defined = new Set(
    [...SOURCE.matchAll(/\.(st-[a-z-]+)/g)].map((match) => match[1]),
  )
  const used = new Set(
    [...SOURCE.matchAll(/className: '([^']+)'/g)]
      .flatMap((match) => match[1].split(' '))
      .filter(Boolean),
  )
  const missing = [...used].filter((name) => !defined.has(name))
  assert.deepEqual(missing, [], `undefined class names: ${missing.join(', ')}`)
})

test('the plugin never writes outside its own surface', () => {
  // A plugin must not append to the body or read another plugin's DOM.
  assert.doesNotMatch(SOURCE, /document\.body\.append/, 'no body appends')
  assert.doesNotMatch(SOURCE, /querySelector\(/, 'no DOM queries into the host')
  assert.doesNotMatch(SOURCE, /@deepseek-ai\//, 'no Harness Client package imports')
})

test('the endpoint is addressed relative to the page', () => {
  assert.match(SOURCE, /new URL\(ENDPOINT, document\.baseURI\)/, 'relative endpoint resolution')
  assert.doesNotMatch(SOURCE, /fetch\('\/api\//, 'no origin-rooted fetch')
})
