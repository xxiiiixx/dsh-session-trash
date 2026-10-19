/**
 * Browser half of dsh-session-trash.
 *
 * Three contributions, all through slots the host already declares:
 *
 *   - `sidebar.workspaces.session.menu.item` — the "Move to trash" row;
 *   - `shell.overlay` — the confirmation dialog;
 *   - `settings.section` — the Session Trash page.
 *
 * Plain JavaScript, no JSX and no imports from Harness packages: React comes
 * from the module table, everything else is the plugin's own code. The only
 * network call is a POST to this plugin's own Host endpoint, addressed
 * relative to the page so a reverse-proxy prefix or the desktop shell's
 * custom protocol both keep working.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-trash',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    /** Locale namespace shared by the Host row and this bundle. */
    const NS = 'session-trash'

    /** Relative endpoint; resolved against the page base, never an absolute URL. */
    const ENDPOINT = 'api/session-trash'

    const ZH = {
      'menu.title': '移入回收站',
      'menu.aria': '把会话移入回收站',
      'dialog.title': '移入回收站',
      'dialog.desc': '会话“{title}”将从侧边栏移除，并保留在回收站里，可以随时还原。',
      'dialog.path': '原路径',
      'dialog.size': '占用',
      'dialog.files': '{files} 个文件',
      'dialog.loading': '正在检查会话状态…',
      'dialog.confirm': '移入回收站',
      'dialog.cancel': '取消',
      'dialog.busy': '正在移动…',
      'dialog.done': '已移入回收站。可在「设置 → 会话回收站」中还原。',
      'dialog.carried': '将一并移入 {count} 个派生自该会话的子代理会话（分叉的会话会保留）。',
      'dialog.close': '关闭',
      'blocker.title': '暂时不能删除这个会话',
      'blocker.live': '这个会话正在运行。请先停止它或让它空闲后再试。',
      'blocker.has-children': '这个会话的子代理会话本身还有子会话，无法整体搬运。',
      'blocker.not-found': '找不到这个会话的存储目录。',
      'blocker.foreign-session': '目录内容与会话身份不符，已拒绝操作。',
      'blocker.symlink': '会话目录是一个符号链接，已拒绝操作。',
      'blocker.outside-root': '路径不在会话根目录内，已拒绝操作。',
      'blocker.activity-unknown': '无法读取会话列表，因此无法确认是否还有正在运行的工作；请稍后再试。',
      'blocker.child-running': '这个会话派生出的某个子代理仍在运行，请先停止它。',
      'trash.nav': '会话回收站',
      'trash.title': '会话回收站',
      'trash.desc': '在这里还原或永久清除已删除的会话。删除的会话会在回收站保留一段时间，超过保留期后由 Harness 在下次启动时自动清除。',
      'trash.descNoRetention': '在这里还原或永久清除已删除的会话。自动清理已关闭。',
      'trash.empty': '回收站是空的。',
      'trash.loading': '正在读取回收站…',
      'trash.error': '读取回收站失败：{message}',
      'trash.columnTitle': '会话',
      'trash.columnPath': '原路径',
      'trash.columnDeleted': '删除时间',
      'trash.columnSize': '大小',
      'trash.columnActions': '操作',
      'trash.restore': '还原',
      'trash.restoring': '还原中…',
      'trash.purge': '永久清除',
      'trash.purgeConfirm': '再次点击以永久删除',
      'trash.purging': '清除中…',
      'trash.purgeAll': '清空回收站',
      'trash.purgeAllConfirm': '再次点击以清空',
      'trash.refresh': '刷新',
      'trash.broken': '此条目已损坏，只能永久清除',
      'trash.unknownTitle': '(无标题)',
      'trash.retentionOff': '自动清理已关闭',
      'error.bad-request': '请求无效。',
      'error.invalid-id': '会话标识无效。',
      'error.not-found': '找不到该会话或回收站条目。',
      'error.live': '会话正在运行，无法删除。',
      'error.has-children': '会话存在子会话，无法删除。',
      'error.already-exists': '目标位置已存在同名会话目录。',
      'error.outside-root': '目标路径越界，操作已拒绝。',
      'error.foreign-session': '目录内容与会话身份不符，操作已拒绝。',
      'error.cross-volume': '回收站与会话不在同一个磁盘分区，无法移动。',
      'error.busy': '文件被占用或权限不足，请稍后再试。',
      'error.too-many': '回收站条目过多，请先清理。',
      'error.corrupt': '回收站条目已损坏。',
      'error.unavailable': '会话回收站尚未配置完成。',
      'error.network': '无法连接到 Harness。',
    }

    const EN = {
      'menu.title': 'Move to trash',
      'menu.aria': 'Move this session to the trash',
      'dialog.title': 'Move to trash',
      'dialog.desc': 'Session "{title}" leaves the sidebar and moves to the trash, where you can restore it later.',
      'dialog.path': 'Original path',
      'dialog.size': 'Size',
      'dialog.files': '{files} files',
      'dialog.loading': 'Checking the session…',
      'dialog.confirm': 'Move to trash',
      'dialog.cancel': 'Cancel',
      'dialog.busy': 'Moving…',
      'dialog.done': 'Moved to the trash. Restore it from Settings → Session Trash.',
      'dialog.carried': 'Also moves {count} subagent session(s) derived from this one. Forked sessions stay.',
      'dialog.close': 'Close',
      'blocker.title': 'This session cannot be deleted right now',
      'blocker.live': 'The session is running. Stop it or let it go idle first.',
      'blocker.has-children': 'A subagent session of this one has children of its own, so it cannot be carried as a unit.',
      'blocker.not-found': 'No storage directory was found for this session.',
      'blocker.foreign-session': 'The directory does not belong to this session; the operation was refused.',
      'blocker.symlink': 'The session directory is a symbolic link; the operation was refused.',
      'blocker.outside-root': 'The path is outside the sessions root; the operation was refused.',
      'blocker.activity-unknown': 'The session list could not be read, so running work cannot be ruled out. Try again in a moment.',
      'blocker.child-running': 'A subagent session derived from this one is still running. Stop it first.',
      'trash.nav': 'Session Trash',
      'trash.title': 'Session Trash',
      'trash.desc': 'Restore or permanently purge deleted sessions. Deleted sessions stay in the trash for a while; past the retention window Harness removes them on its next start.',
      'trash.descNoRetention': 'Restore or permanently purge deleted sessions. Automatic cleanup is off.',
      'trash.empty': 'The trash is empty.',
      'trash.loading': 'Reading the trash…',
      'trash.error': 'Could not read the trash: {message}',
      'trash.columnTitle': 'Session',
      'trash.columnPath': 'Original path',
      'trash.columnDeleted': 'Deleted',
      'trash.columnSize': 'Size',
      'trash.columnActions': 'Actions',
      'trash.restore': 'Restore',
      'trash.restoring': 'Restoring…',
      'trash.purge': 'Purge',
      'trash.purgeConfirm': 'Click again to purge',
      'trash.purging': 'Purging…',
      'trash.purgeAll': 'Empty trash',
      'trash.purgeAllConfirm': 'Click again to empty',
      'trash.refresh': 'Refresh',
      'trash.broken': 'This entry is damaged and can only be purged',
      'trash.unknownTitle': '(untitled)',
      'trash.retentionOff': 'Automatic cleanup is off',
      'error.bad-request': 'The request was invalid.',
      'error.invalid-id': 'The session identifier was invalid.',
      'error.not-found': 'The session or trash entry no longer exists.',
      'error.live': 'The session is running and cannot be deleted.',
      'error.has-children': 'The session has child sessions and cannot be deleted.',
      'error.already-exists': 'A session directory already exists at the target location.',
      'error.outside-root': 'The target path was outside its root; the operation was refused.',
      'error.foreign-session': 'The directory does not belong to this session; the operation was refused.',
      'error.cross-volume': 'The trash is on a different volume than the session, so it cannot be moved.',
      'error.busy': 'The files are in use or permissions are insufficient. Try again later.',
      'error.too-many': 'The trash holds too many entries; purge some first.',
      'error.corrupt': 'This trash entry is damaged.',
      'error.unavailable': 'Session Trash is not configured.',
      'error.network': 'Could not reach the Harness host.',
    }

    /** Fill `{name}` placeholders. */
    function format(template, params) {
      if (params === undefined) return template
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
      )
    }

    /** Human-readable byte count. */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '—'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
    }

    /** Locale-aware timestamp; falls back to the raw value. */
    function formatWhen(iso, locale) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const time = Date.parse(iso)
      if (!Number.isFinite(time)) return iso
      try {
        return new Date(time).toLocaleString(locale)
      } catch {
        return iso
      }
    }

    /** A pluggable error whose `code` the UI translates. */
    class TrashRequestError extends Error {
      constructor(code, message) {
        super(message)
        this.code = code
      }
    }

    /** Map a thrown value onto a translation key. */
    function errorKey(t, error) {
      const code = error instanceof TrashRequestError ? error.code : 'network'
      const key = `error.${code}`
      const text = t(key)
      return text === key ? format(t('trash.error'), { message: String(error?.message ?? error) }) : text
    }

    /**
     * POST one operation to the Host endpoint.
     * @param {Record<string, unknown>} payload - `{ op, ... }`.
     * @returns {Promise<any>} the response body.
     */
    async function call(payload) {
      let response
      try {
        response = await fetch(new URL(ENDPOINT, document.baseURI).href, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'same-origin',
        })
      } catch (error) {
        throw new TrashRequestError('network', error instanceof Error ? error.message : String(error))
      }
      let body
      try {
        body = await response.json()
      } catch {
        throw new TrashRequestError('network', `HTTP ${response.status}`)
      }
      if (!response.ok || body?.ok !== true) {
        throw new TrashRequestError(String(body?.code ?? 'network'), String(body?.message ?? `HTTP ${response.status}`))
      }
      return body
    }

    /** Minimal external store; components subscribe through {@link useStore}. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /** Read one store value and re-render on change. */
    function useStore(store) {
      const [value, setValue] = useState(store.get)
      useEffect(() => {
        setValue(store.get())
        return store.subscribe(() => setValue(store.get()))
      }, [store])
      return value
    }

    /** Shared, module-scoped state: the pending confirmation and the trash list. */
    const requestStore = createStore(null)
    const listStore = createStore({ status: 'idle', entries: [], error: null })
    let listInflight = null

    /** Reload the trash listing once at a time. */
    function refreshTrash(t) {
      if (listInflight !== null) return listInflight
      listStore.set({ ...listStore.get(), status: 'loading', error: null })
      listInflight = call({ op: 'list' })
        .then((body) => {
          listStore.set({ status: 'ready', entries: Array.isArray(body.entries) ? body.entries : [], error: null })
        })
        .catch((error) => {
          listStore.set({ status: 'failed', entries: [], error: errorKey(t, error) })
        })
        .finally(() => {
          listInflight = null
        })
      return listInflight
    }

    /**
     * Stylesheet.
     *
     * The `.st-menuitem*` and `.st-button*` rules are copied from the host's own
     * primitives (`MenuItemButton` in `ui-primitives`, `Button` in the shell) so
     * this plugin's rows sit pixel-for-pixel beside the shipped ones. Only the
     * class prefix and the token names are kept as-is: those tokens are the
     * contract, and a renamed token degrades appearance rather than breaking the
     * page. Attribution: derived from DeepSeek Harness (MIT).
     */
    const STYLE = `
.st-menuitem-wrap { position: relative; }
.st-menuitem { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; padding: 6px 8px; border: none; border-radius: var(--dsw-radius-md); background: transparent; cursor: pointer; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); text-align: left; }
.st-menuitem:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.st-menuitem:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.st-menuitem:disabled { opacity: .4; cursor: not-allowed; }
.st-menuitem-icon { display: inline-flex; flex: none; width: 14px; height: 14px; align-items: center; justify-content: center; color: var(--dsw-alias-menu-icon); }
.st-menuitem-icon svg { width: 14px; height: 14px; }
.st-menuitem-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-menuitem[data-danger="true"], .st-menuitem[data-danger="true"] .st-menuitem-icon { color: var(--dsw-alias-state-error-primary); }
.st-menuitem[data-danger="true"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.st-menuitem[data-danger="true"]:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); outline: none; }

.st-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 36px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md); cursor: pointer; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); background: transparent; }
.st-button:disabled { cursor: not-allowed; opacity: .4; }
.st-button[data-variant="outline"] { border: .5px solid var(--dsw-alias-border-l3); background: transparent; }
.st-button[data-variant="outline"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
/* The host's destructive confirm (ui-workspace's delete-action class) is an
   outline button whose TEXT turns red — not a red-bordered one. Match that. */
.st-button[data-destructive="true"]:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
.st-button[data-variant="primary"] { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.st-button[data-variant="primary"]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }

.st-backdrop { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent); backdrop-filter: blur(2px); pointer-events: auto; z-index: 60; }
.st-dialog { width: min(520px, 100%); max-height: min(640px, 100%); display: flex; flex-direction: column; gap: 14px; padding: 20px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; background: var(--dsw-alias-bg-overlay); box-shadow: 0 18px 48px rgba(0,0,0,.28); overflow: auto; }
.st-dialog h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.st-dialog p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.st-facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.st-facts dt { margin: 0; color: var(--dsw-alias-label-secondary); }
.st-facts dd { margin: 0; color: var(--dsw-alias-label-primary); word-break: break-all; }
.st-notice { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); font-size: 13px; line-height: 1.6; }
.st-notice[data-tone="block"] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }
.st-notice[data-tone="error"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.st-notice[data-tone="done"] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.st-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.st-section { display: flex; flex-direction: column; gap: 14px; }
.st-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.st-header h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.st-header p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); max-width: 60ch; }
.st-table { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; }
.st-thead, .st-trow { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1.6fr) 130px 90px max-content; gap: 12px; align-items: center; padding: 9px 12px; }
.st-thead { background: var(--dsw-alias-bg-layer-2); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-secondary); }
.st-trow { border-top: 1px solid var(--dsw-alias-border-l1); font-size: 13px; color: var(--dsw-alias-label-primary); }
.st-trow:hover { background: var(--dsw-alias-bg-layer-2); }
.st-cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-cell-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.st-actions-cell { display: flex; gap: 6px; justify-content: flex-end; }
.st-empty { padding: 28px 12px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.st-broken { color: var(--dsw-alias-state-warn-primary); font-size: 12px; }
`

    /**
     * Inject the plugin stylesheet once for the whole run.
     *
     * It used to be a `<style>` element rendered by the dialog and the settings
     * page. That left the *menu row* unstyled until a dialog had mounted — it
     * rendered as the browser's default button (grey background, default font),
     * which is exactly how it looked wrong beside the shipped rows. Injecting on
     * activation covers every surface, and `ctx.effect` removes it on unload.
     *
     * The mount point falls back to `body` for a run whose `<head>` is not
     * reachable yet, because a missing stylesheet degrades every surface at once
     * while a slightly late one only delays paint.
     *
     * @param {object} ctx - the Client plugin context.
     */
    function installStyle(ctx) {
      ctx.effect(() => {
        const element = document.createElement('style')
        element.dataset.dshSessionTrash = ''
        element.textContent = STYLE
        const host = document.head ?? document.body
        if (host === null || host === undefined) return () => undefined
        host.append(element)
        return () => element.remove()
      }, 'dsh-session-trash: stylesheet')
    }

    /**
     * Trash can glyph, drawn here so the plugin depends on no icon package.
     *
     * The host's menu icons are 14px line icons inside a 14px cell; this one is
     * sized by CSS (`.st-menuitem-icon svg { width/height: 14px }`) rather than
     * by attributes, so it inherits the cell exactly like a host icon does.
     */
    function TrashIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M2.5 4.5h11' }),
        h('path', { d: 'M6 4.5V3.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 .75.75V4.5' }),
        h('path', { d: 'M4.2 4.5l.62 8.1a1 1 0 0 0 1 .9h4.36a1 1 0 0 0 1-.9l.62-8.1' }),
        h('path', { d: 'M6.6 7v4M9.4 7v4' }),
      )
    }

    /**
     * The sidebar menu row, shaped exactly like the host's `MenuItemButton`
     * (icon cell, flexible label, `role="menuitem"`, danger colouring) so it
     * reads as one of the shipped rows rather than a guest control.
     */
    function TrashMenuButton(props) {
      const { sessionId, displayTitle, t } = props
      const closeMenu = useMenuCloser(props)
      return h(
        'div',
        { className: 'st-menuitem-wrap' },
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'st-menuitem',
            'data-danger': 'true',
            'aria-label': t('menu.aria'),
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              closeMenu()
              requestStore.set({ sessionId, displayTitle, stage: 'plan' })
            },
          },
          h('span', { className: 'st-menuitem-icon' }, h(TrashIcon)),
          h('span', { className: 'st-menuitem-label' }, t('menu.title')),
        ),
      )
    }

    /** A stand-in hook used only when a slot variant omits `useMenuOpenState`. */
    const NO_MENU_STATE = () => [false, undefined]

    /**
     * Close the host menu through the slot's own hook.
     *
     * The hook identity is fixed for as long as the entry is mounted, so React's
     * hook order stays stable; the fallback lets a slot variant that omits the
     * hook degrade to "the menu closes itself" instead of crashing the row.
     *
     * @param {object} props - component props.
     * @returns {() => void} the close action.
     */
    function useMenuCloser(props) {
      const hook = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState : NO_MENU_STATE
      const pair = hook()
      const setter = Array.isArray(pair) ? pair[1] : undefined
      return useCallback(() => {
        if (typeof setter === 'function') setter(false)
      }, [setter])
    }

    /** The confirmation dialog, mounted for the lifetime of the overlay slot. */
    function TrashConfirmDialog({ t }) {
      const request = useStore(requestStore)
      const [plan, setPlan] = useState(null)
      const [busy, setBusy] = useState(false)
      const [done, setDone] = useState(false)
      const [error, setError] = useState(null)
      const confirmRef = useRef(null)

      const sessionId = request?.sessionId

      // Load the preflight every time a new request opens. Abort on close so a
      // slow answer cannot resurrect a dismissed dialog.
      useEffect(() => {
        if (sessionId === undefined || done) {
          setPlan(null)
          setError(null)
          return undefined
        }
        let cancelled = false
        setPlan(null)
        setError(null)
        call({ op: 'plan', sessionId })
          .then((body) => {
            if (!cancelled) setPlan(body)
          })
          .catch((reason) => {
            if (!cancelled) setError(errorKey(t, reason))
          })
        return () => {
          cancelled = true
        }
      }, [sessionId, done, t])

      useEffect(() => {
        if (request !== null && plan !== null && confirmRef.current !== null) confirmRef.current.focus()
      }, [request, plan])

      useEffect(() => {
        if (request === null) {
          setBusy(false)
          setDone(false)
          setError(null)
        }
      }, [request])

      const close = useCallback(() => {
        if (busy) return
        requestStore.set(null)
        setDone(false)
      }, [busy])

      useEffect(() => {
        if (request === null) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            close()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [request, close])

      if (request === null) return null

      const title = plan?.title ?? request.displayTitle ?? sessionId
      const blockers = Array.isArray(plan?.blockers) ? plan.blockers : []
      const canDelete = plan !== null && plan.canDelete !== false && blockers.length === 0 && !busy

      const confirm = () => {
        if (!canDelete) return
        setBusy(true)
        setError(null)
        call({ op: 'trash', sessionId })
          .then(() => {
            setBusy(false)
            setDone(true)
            void refreshTrash(t)
          })
          .catch((reason) => {
            setBusy(false)
            setError(errorKey(t, reason))
          })
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          {
            className: 'st-backdrop',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) close()
            },
          },
          h(
            'div',
            {
              className: 'st-dialog',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': 'st-dialog-title',
            },
            h('h2', { id: 'st-dialog-title' }, t('dialog.title')),
            done
              ? h('div', { className: 'st-notice', 'data-tone': 'done', role: 'status' }, t('dialog.done'))
              : h('p', null, format(t('dialog.desc'), { title })),
            done
              ? null
              : h(
                  'dl',
                  { className: 'st-facts' },
                  h('dt', null, t('dialog.path')),
                  h('dd', null, plan?.cwd ?? '—'),
                  h('dt', null, t('dialog.size')),
                  h(
                    'dd',
                    null,
                    plan === null
                      ? '—'
                      : plan.materialized === false
                        ? '—'
                        : `${formatBytes(plan.bytes)} · ${format(t('dialog.files'), { files: plan.files })}`,
                  ),
                ),
            plan !== null && Array.isArray(plan.carried) && plan.carried.length > 0
              ? h(
                  'div',
                  { className: 'st-notice', 'data-tone': 'block' },
                  format(t('dialog.carried'), { count: plan.carried.length }),
                )
              : null,
            plan === null && error === null && !done
              ? h('p', { role: 'status' }, t('dialog.loading'))
              : null,
            blockers.length > 0
              ? h(
                  'div',
                  { className: 'st-notice', 'data-tone': 'block', role: 'alert' },
                  h('strong', null, t('blocker.title')),
                  h(
                    'ul',
                    { style: { margin: '6px 0 0', paddingInlineStart: '18px' } },
                    ...blockers.map((code) => {
                      const key = `blocker.${code}`
                      const text = t(key)
                      return h('li', { key: code }, text === key ? code : text)
                    }),
                  ),
                )
              : null,
            error !== null ? h('div', { className: 'st-notice', 'data-tone': 'error', role: 'alert' }, error) : null,
            h(
              'div',
              { className: 'st-actions' },
              done
                ? h(
                    'button',
                    { type: 'button', className: 'st-button', 'data-variant': 'outline', onClick: close },
                    t('dialog.close'),
                  )
                : h(
                    React.Fragment,
                    null,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'st-button',
                        'data-variant': 'outline',
                        onClick: close,
                        disabled: busy,
                      },
                      t('dialog.cancel'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'st-button',
                        'data-variant': 'outline',
                        'data-destructive': 'true',
                        disabled: !canDelete,
                        onClick: confirm,
                        ref: confirmRef,
                        'aria-busy': busy ? 'true' : 'false',
                      },
                      busy ? t('dialog.busy') : t('dialog.confirm'),
                    ),
                  ),
            ),
          ),
        ),
      )
    }

    /** One row of the trash table. */
    function TrashRow({ entry, t, locale }) {
      const [armed, setArmed] = useState(false)
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState(null)

      // The two-step confirmation lapses on its own, so a stale armed button
      // can never be clicked much later by reflex.
      useEffect(() => {
        if (!armed) return undefined
        const timer = setTimeout(() => setArmed(false), 4000)
        return () => clearTimeout(timer)
      }, [armed])

      const restore = () => {
        setBusy('restore')
        setError(null)
        call({ op: 'restore', trashId: entry.trashId })
          .then(() => refreshTrash(t))
          .catch((reason) => setError(errorKey(t, reason)))
          .finally(() => setBusy(null))
      }

      const purge = () => {
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        setBusy('purge')
        setError(null)
        call({ op: 'purge', trashId: entry.trashId })
          .then(() => refreshTrash(t))
          .catch((reason) => setError(errorKey(t, reason)))
          .finally(() => setBusy(null))
      }

      const title = entry.title === '' ? t('trash.unknownTitle') : entry.title
      return h(
        'div',
        { className: 'st-trow' },
        h(
          'div',
          { className: 'st-cell', title },
          title,
          error === null ? null : h('div', { className: 'st-broken', role: 'alert' }, error),
        ),
        h('div', { className: 'st-cell st-cell-sub', title: entry.cwd ?? '' }, entry.cwd ?? '—'),
        h('div', { className: 'st-cell st-cell-sub' }, formatWhen(entry.deletedAt, locale)),
        h('div', { className: 'st-cell st-cell-sub' }, formatBytes(entry.bytes)),
        h(
          'div',
          { className: 'st-actions-cell' },
          entry.broken
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'st-button',
                  'data-variant': 'outline',
                  disabled: busy !== null,
                  onClick: restore,
                },
                busy === 'restore' ? t('trash.restoring') : t('trash.restore'),
              ),
          h(
            'button',
            {
              type: 'button',
              className: 'st-button',
              'data-variant': 'outline',
              'data-destructive': 'true',
              disabled: busy !== null,
              onClick: purge,
            },
            busy === 'purge' ? t('trash.purging') : armed ? t('trash.purgeConfirm') : t('trash.purge'),
          ),
        ),
      )
    }

    /** The settings page. */
    function TrashSection({ t }) {
      const state = useStore(listStore)
      const [armed, setArmed] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const locale = useLocaleId()

      useEffect(() => {
        void refreshTrash(t)
      }, [t])

      useEffect(() => {
        if (!armed) return undefined
        const timer = setTimeout(() => setArmed(false), 4000)
        return () => clearTimeout(timer)
      }, [armed])

      const purgeAll = () => {
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        setBusy(true)
        setError(null)
        call({ op: 'purgeAll' })
          .then(() => refreshTrash(t))
          .catch((reason) => setError(errorKey(t, reason)))
          .finally(() => setBusy(false))
      }

      const entries = state.entries
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'st-section' },
          h(
            'div',
            { className: 'st-header' },
            h(
              'div',
              null,
              h('h2', null, t('trash.title')),
              h('p', null, t('trash.desc')),
            ),
            h(
              'div',
              { className: 'st-actions-cell' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'st-button',
                  'data-variant': 'outline',
                  onClick: () => refreshTrash(t),
                  disabled: state.status === 'loading',
                },
                t('trash.refresh'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'st-button',
                  'data-variant': 'outline',
                  'data-destructive': 'true',
                  disabled: busy || entries.length === 0,
                  onClick: purgeAll,
                },
                busy ? t('trash.purging') : armed ? t('trash.purgeAllConfirm') : t('trash.purgeAll'),
              ),
            ),
          ),
          error !== null ? h('div', { className: 'st-notice', 'data-tone': 'error', role: 'alert' }, error) : null,
          state.error !== null
            ? h('div', { className: 'st-notice', 'data-tone': 'error', role: 'alert' }, state.error)
            : null,
          h(
            'div',
            { className: 'st-table' },
            h(
              'div',
              { className: 'st-thead' },
              h('div', null, t('trash.columnTitle')),
              h('div', null, t('trash.columnPath')),
              h('div', null, t('trash.columnDeleted')),
              h('div', null, t('trash.columnSize')),
              h('div', null, t('trash.columnActions')),
            ),
            state.status === 'loading' && entries.length === 0
              ? h('div', { className: 'st-empty', role: 'status' }, t('trash.loading'))
              : entries.length === 0
                ? h('div', { className: 'st-empty', role: 'status' }, t('trash.empty'))
                : entries.map((entry) =>
                    h(TrashRow, { key: entry.trashId, entry, t, locale }),
                  ),
          ),
        ),
      )
    }

    /** The active locale id, for date formatting only. */
    function useLocaleId() {
      const [id, setId] = useState(() => readLang())
      useEffect(() => {
        const observer = new MutationObserver(() => setId(readLang()))
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        return () => observer.disconnect()
      }, [])
      return id
    }

    /** Read `<html lang>` defensively; its absence is not an error. */
    function readLang() {
      try {
        return document.documentElement.lang || undefined
      } catch {
        return undefined
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        installStyle(ctx)
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-session-trash: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: 'dsh-session-trash:delete',
              order: 500,
              locale: NS,
            },
            TrashMenuButton,
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-session-trash:confirm',
              order: 40,
              locale: NS,
            },
            TrashConfirmDialog,
          ),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-session-trash',
              order: 110,
              label: () => t('trash.nav'),
              locale: NS,
            },
            TrashSection,
          ),
        )
      },
    }
  },
})
