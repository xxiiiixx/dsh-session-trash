# dsh-session-trash

**Session Trash for DeepSeek Harness Desktop** — move a session into a
recoverable trash from the sidebar menu, then restore or permanently purge it
from **Settings → Session Trash**.

English | [中文](README.zh.md)

![Session Trash icon](icon.svg)

## Summary

Harness keeps every session log forever. `sessionPersistence` has no deletion
API — *"Nothing deletes session files"* — and the workspace registry only
archives, leaving the log on disk. This plugin adds the missing capability in
the safest shape it can take: a **recoverable** move, a **user-only** trigger,
and no filesystem path ever crossing the wire.

## Table of Contents

- [Use this plugin](#use-this-plugin)
- [Configuration](#configuration)
- [Safety model](#safety-model)
- [Scope](#scope)
- [Verification](#verification)
- [Further exploration](#further-exploration)
- [Disclaimer](#disclaimer)
- [Known limitations](#known-limitations)

-----

<a id="use-this-plugin"></a>
## Use this plugin

| Where | What it does |
|---|---|
| Session row → `…` menu | **Move to trash** — the host's own `MenuItemButton` geometry (same height, padding, icon cell and label rhythm) with its danger colouring |
| Confirmation dialog | Shows the title, original path and size before anything moves; the destructive confirm is the host's outline-with-red-text pattern |
| Settings → **Session Trash** | Lists deleted sessions with **Restore** and **Purge**, plus **Empty trash** |
| Host startup | Removes entries older than `retentionDays` (default 30), silently |

A deletion **moves the session's directory** with a single `rename` into
`$DSH_HOME/session-trash/<UTC stamp>-<session id>/`, and writes a
`manifest.json` beside it. Nothing is copied, so an interruption cannot leave a
half-deleted session, and a failed move leaves both directories exactly as they
were.

### Install

The plugin is an ordinary Harness bundle, so it installs where every other
plugin does:

```bash
dsh plugin --profile desktop add github:xxiiiixx/dsh-session-trash
```

From a local checkout, point Plugin Manager at the directory (Settings →
Plugins → Add, or the `plugin_manager` tool with `install_bundle`). The row it
inserts is named `dsh-session-trash`, and it is enabled immediately. Restart
Harness if Plugin Manager reports `restart-required`.

<a id="configuration"></a>
## Configuration

The bundle patch inserts the Host row with no config: the plugin resolves both
roots from the running DSH home at activation, so a normal install needs no
per-machine editing. Every field stays overridable from the profile's own patch
layer.

| Field | Default | Meaning |
|---|---|---|
| `sessionsRoot` | `$DSH_HOME/sessions` | Where the session backend stores logs |
| `trashRoot` | `$DSH_HOME/session-trash` | Where deleted sessions go; must be on the same volume as `sessionsRoot` |
| `retentionDays` | `30` | Automatic purge age; `0` disables the sweep |
| `sweepOnStart` | `true` | Run the retention sweep once per Host start |
| `maxTrashEntries` | `500` | Refuse new deletions above this count; `0` means unlimited |

```yaml
- id: dsh-session-trash
  name: 'dsh-session-trash'
  config:
    retentionDays: 90
```

<a id="safety-model"></a>
## Safety model

Deleting a session is destructive, so most of this plugin is refusals rather
than deletion.

1. **Recoverable by default.** A deletion is a move, not an unlink. Purging is a
   separate, explicit action inside the trash page.
2. **No path crosses the wire.** The client sends `{ op, sessionId }` or
   `{ op, trashId }`. The Host resolves identifiers against its own roots; there
   is no `path` field to smuggle.
3. **Identifiers are whitelisted** (`^[A-Za-z0-9._-]+$`, ≤ 200 characters, never
   `.`/`..`) and every resolved path is checked with `path.relative` after
   `realpath`, so a symlink or a crafted id cannot escape a root.
4. **Directories prove their identity.** Before moving anything the plugin reads
   the log's header line and refuses unless `header.id` matches the requested
   session.
5. **Only a running turn blocks a delete.** Liveness is read exactly the way the
   shipped archive action reads it: an Agent counts as busy only while its
   `status` is `running`. An idle Agent that merely stays resident in the
   registry does **not** block — a session you already stopped is deletable. An
   Agent surface that cannot report a status is treated as running, so the
   plugin never guesses its way into moving a log that may still be written.
6. **A derived subagent session travels with its parent; a fork does not.** A
   session with `origin: subagent` exists only to carry out work for its parent,
   so a stopped one moves into the *same* trash entry and returns with the
   parent on restore. A fork (`isSeeded`) is seeded from the parent's history
   and then stands on its own: it stays put and does not block. A derived child
   that is still running, or that has children of its own, refuses the whole
   carry and says why.
7. **`rename` only, never copy-then-delete.** `EXDEV`, `EPERM` and `EBUSY` are
   reported as `cross-volume` / `busy`; no fallback exists that could leave a
   duplicate or a partial copy.
8. **Serialized mutations.** One promise chain per service, plus a re-run of
   every preflight immediately before the move, which closes the window between
   the dialog and the action.
9. **No agent tool.** The Host half registers no tool at all. Only a person
   clicking the UI can delete a session; the model cannot.
10. **One endpoint, behind the standard fence.** `POST /api/session-trash` is
    mounted on `ctx.connection.fetch`, so it inherits Harness's Host/Origin and
    browser-credential checks. Bodies are capped at 64 KiB, operations are a
    closed set, and failures answer with a stable `code` plus a fixed sentence —
    never a filesystem path.
11. **The Host log is the source of truth.** Deletion drops the session from the
    workspace pin/archive sets and emits `api-session/removed`, the same event
    the sidebar already listens for, so the row disappears immediately without
    any plugin-private state.

<a id="scope"></a>
## Scope

- **Allowed:** any session that is not running and whose derived children, if
  any, are stopped.
- **Refused:** a running session or derived child, a derived child that has
  children, a directory that is not provably that session, and anything outside
  the configured root.
- **Not touched:** attachments referenced by the deleted log (the attachment
  store is global and immutable), and projection-cache rows (they are hints only
  and self-heal).

<a id="verification"></a>
## Verification

```bash
npm test            # 65 cases: paths, config, trash service, HTTP route, Client bundle
npm run e2e         # end-to-end walk through the HTTP handler
npm run audit       # read-only verdict for every real session on this machine
npm run check:css   # diff the copied styles against the host's own stylesheet
npm run check:liveness
```

The suite builds throwaway session roots with real Zstandard logs and asserts:
read-only preflight, identity-mismatch refusal, running and derived-child
refusals, atomic move with rollback, manifest round-trip, restore collision,
purge containment (`../../etc` is rejected), corrupt-manifest handling,
retention sweep, capacity refusal, and serialized concurrency. The Client suite
executes `client.js` inside a stubbed module loader and asserts the stylesheet is
installed before any slot registers — the regression that once left the menu row
looking like a bare browser button.

<a id="further-exploration"></a>
## Further exploration

- [CHANGELOG](CHANGELOG.md) — what each release changed and why.
- `@deepseek-ai/dsh-session-persistence-jsonl` — the on-disk layout this plugin
  reads and moves.
- `@deepseek-ai/dsh-workspace` — the registry whose `sessionIds` sets deletion
  updates.

<a id="disclaimer"></a>
## Disclaimer

**This plugin deletes data. Read this before you install it.**

- **You are responsible for what you delete.** The plugin moves session logs out
  of `sessionsRoot` and can permanently remove them on request. A deletion you
  confirm is a change to your own files; the author is not responsible for lost
  sessions, lost history, or work that cannot be reconstructed. Back up anything
  you cannot afford to lose before trying it for the first time.
- **Provided as is, without warranty.** The software is offered under the MIT
  license, which supplies it "as is", without warranty of any kind, express or
  implied, and disclaims all liability for damages arising from its use. See
  [LICENSE](LICENSE) — that text governs.
- **Not affiliated with DeepSeek.** This is an independent, third-party plugin.
  It is not endorsed by, sponsored by, or supported by DeepSeek. DeepSeek Harness
  and its marks belong to their respective owners; names appear here only to
  describe what the plugin works with.
- **It depends on internals that can change.** The plugin reads the shipped JSONL
  backend's on-disk layout and the host's own menu primitives by copying their
  styles. A Harness update may change either, and the plugin may then stop
  working correctly. Verify against a session you can afford to lose before
  relying on it for anything important.
- **A move can be refused or fail part-way.** The plugin reports `cross-volume`,
  `busy`, `live`, `has-children` and the other codes rather than forcing a
  deletion, and it rolls back a partial carry. A refusal is the safe outcome, not
  a defect — do not work around it by editing files by hand.
- **Only a person can delete.** No agent tool is registered. If a session was
  deleted, a person clicked the button, and the responsibility is theirs.
- **No support commitment.** Issues and pull requests are welcome, but there is
  no promise of response time, fixes, or continued maintenance.

<a id="known-limitations"></a>
## Known limitations

- **A linked install has no build step.** Both halves ship plain JavaScript, so
  a directory install loads as-is. Editing the installed bundle is picked up on
  the next page load for the Client; the Host half needs a plugin reload or a
  Harness restart, because Node caches ES modules per process.
- Sessions are matched by their encoded id inside `$DSH_HOME/sessions/<project>/`,
  the shipped JSONL backend's layout. A different persistence backend would need
  its own locator.
- The trash cannot cross volumes: `trashRoot` must sit on the same volume as
  `sessionsRoot`. The default keeps both under `$DSH_HOME`, so this only matters
  if you move one of them.

## License

MIT. See [LICENSE](LICENSE).
