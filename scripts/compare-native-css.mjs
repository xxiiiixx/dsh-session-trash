/**
 * Compare this plugin's copied menu-row rules against the host's real
 * MenuItemButton rules, property by property.
 *
 * Read-only: it opens the DSH installation's own CSS inside the asar and prints
 * a diff. No DOM, no rendering — just the two rule bodies side by side.
 */
import fs from 'node:fs'
import { readFileSync } from 'node:fs'

const ASAR = 'D:/study/DeepSeek/resources/app.asar'
const PLUGIN = new URL('../client.js', import.meta.url)

const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const size = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(size)
fs.readSync(fd, headerBuf, 0, size, 16)
const header = JSON.parse(headerBuf.toString('utf8'))
const base = 8 + head.readUInt32LE(4)

function walk(node, prefix, out) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (val.files) walk(val, p, out)
    else if (val.offset !== undefined) out.push([p, val.offset, val.size])
  }
  return out
}

const all = walk(header, '', [])
const cssEntry = all.find(([p]) => p.endsWith('dsh-web-frontend/dist/assets/index-BxpfOGf3.css'))
if (cssEntry === undefined) {
  console.error('frontend stylesheet not found; the build hash may have changed')
  process.exit(2)
}
const cssBuf = Buffer.alloc(cssEntry[2])
fs.readSync(fd, cssBuf, 0, cssEntry[2], base + Number(cssEntry[1]))
const Css = cssBuf.toString('utf8')

/** Pull the *unscoped* rule body for a class, ignoring `.scope .class{...}` forms. */
function rule(selector) {
  let from = 0
  for (;;) {
    const at = Css.indexOf(`${selector}{`, from)
    if (at < 0) return undefined
    // A rule is unscoped when the character before it ends a declaration block
    // or begins the sheet — not a descendant-combinator space.
    const before = at === 0 ? '}' : Css[at - 1]
    if (before === '}' || before === ';' || at === 0) {
      const open = at + selector.length + 1
      const close = Css.indexOf('}', open)
      return Css.slice(open, close)
    }
    from = at + selector.length
  }
}

/** Parse a body into [property, value] pairs, in authored order. */
function declarations(body) {
  return body
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf(':')
      return [part.slice(0, i).trim(), part.slice(i + 1).trim()]
    })
}

const pluginSrc = readFileSync(PLUGIN, 'utf8')

/** Pull one of our rules out of the template literal. */
function ours(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(pluginSrc)
  return match === null ? undefined : match[1]
}

const pairs = [
  ['menu row', '._item_4ub78_90', '.st-menuitem'],
  ['menu row wrap', '._itemWrap_4ub78_90', '.st-menuitem-wrap'],
  ['menu row hover', '._item_4ub78_90:hover:not(:disabled)', '.st-menuitem:hover:not(:disabled)'],
  ['menu row focus', '._item_4ub78_90:focus-visible:not(:disabled)', '.st-menuitem:focus-visible:not(:disabled)'],
  ['menu row disabled', '._item_4ub78_90:disabled', '.st-menuitem:disabled'],
  ['icon cell', '._itemIcon_4ub78_148', '.st-menuitem-icon'],
  ['label cell', '._itemLabel_4ub78_190', '.st-menuitem-label'],
  ['dialog button', '._button_1rv3m_2', '.st-button'],
  ['button disabled', '._button_1rv3m_2:disabled', '.st-button:disabled'],
  ['button outline', '._outline_1rv3m_54', '.st-button[data-variant="outline"]'],
  ['button primary', '._primary_1rv3m_36', '.st-button[data-variant="primary"]'],
]

/**
 * Declarations the host splits into a separate size class, written by us on the
 * base rule because we have no variant system. Listed explicitly so the diff
 * stays honest instead of hiding them.
 */
const EXPECTED_ON_OURS = new Map([
  ['.st-button', ['height']],
  ['.st-menuitem-icon', []],
])

let mismatches = 0
for (const [label, nativeSel, ourSel] of pairs) {
  const nativeBody = rule(nativeSel)
  const ourBody = ours(ourSel)
  if (nativeBody === undefined) {
    console.log(`?  ${label}: native rule ${nativeSel} not found`)
    continue
  }
  if (ourBody === undefined) {
    console.log(`MISSING  ${label}: our rule ${ourSel} not found`)
    mismatches += 1
    continue
  }
  const nativeDecls = new Map(declarations(nativeBody))
  const ourDecls = new Map(declarations(ourBody))
  const extraAllowed = new Set(EXPECTED_ON_OURS.get(ourSel) ?? [])
  const diffs = []
  for (const [prop, value] of nativeDecls) {
    const mine = ourDecls.get(prop)
    if (mine === undefined) diffs.push(`  - ${prop}: ${value}   (absent)`)
    else if (mine !== value) diffs.push(`  ~ ${prop}: native "${value}" vs ours "${mine}"`)
  }
  for (const [prop, value] of ourDecls) {
    if (nativeDecls.has(prop) || extraAllowed.has(prop)) continue
    diffs.push(`  + ${prop}: ${value}   (only ours)`)
  }
  if (diffs.length === 0) console.log(`OK ${label}: ${nativeDecls.size} declarations identical`)
  else {
    console.log(`DIFF ${label} (${nativeSel})`)
    for (const line of diffs) console.log(line)
    mismatches += diffs.length
  }
}

/**
 * The host's danger variant is written as sibling selectors
 * (`._danger_x`, `._danger_x ._itemIcon_x`), which a single-rule lookup cannot
 * express. Compare its declaration bodies textually instead.
 */
const dangerNative = [
  'color:var(--dsw-alias-state-error-primary)',
  'background:var(--dsw-alias-interactive-bg-hover-danger)',
  'background:var(--dsw-alias-interactive-bg-hover-danger);outline:none',
]
const dangerOurs = [
  '[data-danger="true"], .st-menuitem[data-danger="true"] .st-menuitem-icon { color: var(--dsw-alias-state-error-primary); }',
  '[data-danger="true"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }',
  '[data-danger="true"]:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); outline: none; }',
]
const dangerOk =
  dangerOurs.every((ruleText) => pluginSrc.includes(ruleText)) &&
  dangerNative.every((body) => Css.includes(body))
console.log(dangerOk ? 'OK danger variant: same three declarations as the host' : 'DIFF danger variant')
if (!dangerOk) mismatches += 1

console.log(mismatches === 0 ? '\nall compared rules match the host exactly' : `\n${mismatches} difference(s) above`)
