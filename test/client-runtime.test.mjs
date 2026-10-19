/**
 * Execute the Client bundle the way the module loader does, with a stub React
 * and a stub DOM, and assert the plugin it produces actually behaves.
 *
 * This catches the class of failure a syntax check cannot: a module-level
 * reference error, a wrong export shape, a slot registered with the wrong
 * options, or a stylesheet that never reaches the document.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Minimal React surface: createElement + the hooks the bundle uses. */
function makeReact() {
  const hookState = []
  let cursor = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length === 0 ? undefined : children } }
    },
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const index = cursor++
      if (hookState[index] === undefined) hookState[index] = typeof initial === 'function' ? initial() : initial
      return [hookState[index], (next) => { hookState[index] = next }]
    },
    useEffect() {
      cursor += 1
      return undefined
    },
    useMemo(fn) {
      return fn()
    },
    useCallback(fn) {
      return fn
    },
    useRef(initial) {
      return { current: initial }
    },
    /** Test helper: reset the hook cursor between renders. */
    __resetHooks() {
      cursor = 0
    },
  }
  return React
}

/** Minimal document: enough for style insertion. */
function makeDocument() {
  const appended = []
  return {
    appended,
    head: {
      append(element) {
        appended.push(element)
      },
    },
    createElement(tag) {
      return {
        tag,
        dataset: {},
        textContent: '',
        remove() {
          appended.splice(appended.indexOf(this), 1)
        },
      }
    },
    documentElement: { lang: 'zh-CN' },
    baseURI: 'http://127.0.0.1:3080/',
  }
}

/**
 * Load the bundle and return the plugin object its factory produces.
 * @returns {{ plugin: object, document: object, react: object }}
 */
function loadPlugin() {
  let registered
  const document = makeDocument()
  const react = makeReact()
  const context = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          registered = entry
        },
      },
    },
    document,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    fetch: async () => {
      throw new Error('network is not used in this test')
    },
    TextDecoder,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    Promise,
    Set,
    Map,
    console: { log() {}, warn() {}, error() {} },
  }
  runInNewContext(SOURCE, context, { filename: 'client.js' })
  assert.ok(registered !== undefined, 'the bundle must call __ModuleLoader__.load')
  assert.equal(registered.id, 'dsh-session-trash', 'the module id is the package name')
  const factory = registered.factory
  assert.equal(typeof factory, 'function', 'the bundle must expose a factory')
  const plugin = factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected module request: ${name}`)
  })
  return { plugin, document, react }
}

/** A context that records slot registrations and effects. */
function makeContext(document) {
  const registrations = []
  const disposers = []
  const ctx = {
    effects: [],
    localeDictionaries: null,
    effect(fn, label) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push({ dispose, label })
      ctx.effects.push(label)
      return () => {}
    },
    locale: {
      register(ns, dicts) {
        ctx.localeDictionaries = { ns, dicts }
        return () => {}
      },
      bind() {
        return (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)
      },
    },
    slots: {
      /**
       * The host runs the callback once the owning declaration is on the ledger.
       * The stub runs it immediately, which is the same registration result
       * without waiting for another plugin's activation.
       */
      inject(key, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    document,
    disposers,
  }
  return { ctx, registrations }
}

test('the bundle loads and exports the expected plugin shape', () => {
  const { plugin } = loadPlugin()
  assert.equal(typeof plugin.apply, 'function', 'apply must exist')
  assert.ok(Array.isArray(plugin.inject), 'inject must be an array')
  assert.ok(plugin.inject.includes('slots'), 'slots is required')
  assert.ok(plugin.inject.includes('locale'), 'locale is required')
})

test('apply installs the stylesheet before registering any slot', () => {
  const { plugin, document } = loadPlugin()
  const { ctx } = makeContext(document)
  plugin.apply(ctx)

  // The regression this pins: with the stylesheet rendered by a component, the
  // menu row had no styles until a dialog mounted and looked like a bare button.
  assert.equal(document.appended.length, 1, 'exactly one stylesheet element')
  const style = document.appended[0]
  assert.equal(style.tag, 'style')
  assert.match(style.textContent, /\.st-menuitem \{/, 'the menu row rules are present')
  assert.match(style.textContent, /\.st-button \{/, 'the button rules are present')
  assert.equal(ctx.effects[0], 'dsh-session-trash: stylesheet', 'the stylesheet effect runs first')
})

test('the stylesheet effect removes its element on unload', () => {
  const { plugin, document } = loadPlugin()
  const { ctx } = makeContext(document)
  plugin.apply(ctx)
  assert.equal(document.appended.length, 1)

  // The stylesheet effect is the first disposer collected.
  const stylesheetDisposer = ctx.disposers.find((entry) => entry.label === 'dsh-session-trash: stylesheet')
  assert.ok(stylesheetDisposer !== undefined, 'the stylesheet effect must return a disposer')
  stylesheetDisposer.dispose()
  assert.equal(document.appended.length, 0, 'unload must remove the element')
})

test('all three surfaces register with the host slot names and orders', () => {
  const { plugin, document } = loadPlugin()
  const { ctx, registrations } = makeContext(document)
  plugin.apply(ctx)

  const byName = new Map(registrations.map((entry) => [entry.options.name, entry]))
  assert.ok(byName.has('sidebar.workspaces.session.menu.item'), 'the menu row registers')
  assert.ok(byName.has('shell.overlay'), 'the dialog registers')
  assert.ok(byName.has('settings.section'), 'the settings page registers')

  const menu = byName.get('sidebar.workspaces.session.menu.item')
  assert.equal(menu.options.id, 'dsh-session-trash:delete')
  assert.equal(menu.options.order, 500)
  assert.equal(menu.options.locale, 'session-trash')

  const overlay = byName.get('shell.overlay')
  assert.equal(overlay.options.id, 'dsh-session-trash:confirm')

  const section = byName.get('settings.section')
  assert.equal(section.options.id, 'dsh-session-trash')
  assert.equal(section.options.order, 110)
  assert.equal(typeof section.options.label, 'function', 'the nav label is a thunk so it follows the locale')
})

test('the locale namespace carries both languages', () => {
  const { plugin, document } = loadPlugin()
  const { ctx } = makeContext(document)
  plugin.apply(ctx)
  assert.ok(ctx.localeDictionaries !== null, 'dictionaries registered')
  assert.equal(ctx.localeDictionaries.ns, 'session-trash')
  assert.ok(ctx.localeDictionaries.dicts.zh, 'Chinese dictionary present')
  assert.ok(ctx.localeDictionaries.dicts.en, 'English dictionary present')
  assert.equal(
    Object.keys(ctx.localeDictionaries.dicts.zh).length,
    Object.keys(ctx.localeDictionaries.dicts.en).length,
    'both dictionaries must stay in step',
  )
})

test('rendering the menu row produces the native markup', () => {
  const { plugin, document, react } = loadPlugin()
  const { ctx, registrations } = makeContext(document)
  plugin.apply(ctx)
  const menu = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')

  react.__resetHooks()
  const tree = menu.component({
    sessionId: 'session-a',
    displayTitle: 'Demo',
    t: (key) => key,
    useMenuOpenState: () => [false, () => {}],
  })

  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'st-menuitem-wrap')
  const button = tree.props.children[0]
  assert.equal(button.type, 'button')
  assert.equal(button.props.role, 'menuitem')
  assert.equal(button.props.className, 'st-menuitem')
  assert.equal(button.props['data-danger'], 'true', 'the row keeps its danger colouring')
  const [icon, label] = button.props.children
  assert.equal(icon.props.className, 'st-menuitem-icon')
  assert.equal(label.props.className, 'st-menuitem-label')
  // The stub createElement always collects children into an array; the plugin
  // passes the localized label as the only child.
  assert.deepEqual(label.props.children, ['menu.title'], 'the label comes from the locale')
})

test('rendering the dialog with no pending request renders nothing', () => {
  const { plugin, document, react } = loadPlugin()
  const { ctx, registrations } = makeContext(document)
  plugin.apply(ctx)
  const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay')

  react.__resetHooks()
  const tree = overlay.component({ t: (key) => key })
  assert.equal(tree, null, 'a closed dialog must not paint')
})
