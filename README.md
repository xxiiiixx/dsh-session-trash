# dsh-session-trash — Session Trash for DeepSeek Harness Desktop

English | [中文](README.zh.md)

Move a session into a recoverable trash from the sidebar, then restore or permanently purge it from **Settings → Session Trash**.

![Session Trash icon](icon.svg)

## Why

Harness keeps every session log forever. `sessionPersistence` has no deletion API — “Nothing deletes session files” — and the workspace registry only archives (the log stays on disk). This plugin adds the missing capability in the safest shape it can take: a **recoverable** move, a **user-only** trigger, and no path ever crossing the wire.

## What it does

| Where | What |
|---|---|
| Session row → `…` menu | **Move to trash**, with a confirmation dialog showing the title, original path and size |
| Settings → **Session Trash** | List of deleted sessions with **Restore** and **Purge**; **Empty trash** |
| Host startup | Deletes entries older than `retentionDays` (default 30), silently |

A deletion **moves the session's directory** with a single `rename` into `$DSH_HOME/session-trash/<UTC stamp>-<session id>/` and writes a `manifest.json` beside it. Nothing is copied, so an interruption cannot leave a half-deleted session; a failed move leaves both directories exactly as they were.

## Install

The plugin is a normal Harness bundle. Install it like any other:

```bash
dsh plugin --profile desktop add github:xxiiiixx/dsh-session-trash
```

Or, from a local checkout, point Plugin Manager at the directory (Settings → Plugins → Add, or `plugin_manager` with `install_bundle`). The row it inserts is named `dsh-session-trash`; the plugin is enabled immediately.

Restart Harness if Plugin Manager reports `restart-required`.

## Configuration

The bundle patch resolves both roots from the DSH home, so the defaults below need no editing. Override them in the profile's own patch layer:

| Field | Default | Meaning |
|---|---|---|
| `sessionsRoot` | `$DSH_HOME/sessions` | Where the session backend stores logs |
| `trashRoot` | `$DSH_HOME/session-trash` | Where deleted sessions are moved; must be on the same volume as `sessionsRoot` |
| `retentionDays` | `30` | Automatic purge age; `0` disables the sweep |
| `sweepOnStart` | `true` | Run the retention sweep once per Host start |
| `maxTrashEntries` | `500` | Refuse new deletions above this count; `0` means unlimited |

```yaml
- id: dsh-session-trash
  name: 'dsh-session-trash'
  config:
    retentionDays: 90
```

## Safety model

Deleting a session is destructive, so the implementation spends most of its code on refusals rather than on the delete itself.

1. **Recoverable by default.** A deletion is a move, not an unlink. Purging is a separate, explicit action inside the trash page.
2. **No path crosses the wire.** The client sends `{ op, sessionId }` or `{ op, trashId }`. The Host resolves identifiers against its own roots; there is no `path` field to smuggle.
3. **Identifiers are whitelisted** (`^[A-Za-z0-9._-]+$`, ≤ 200 chars, never `.`/`..`) and every resolved path is checked with `path.relative` after `realpath`, so a symlink or a crafted id cannot escape a root.
4. **Directories prove their identity.** Before moving anything the plugin reads the log's header line and refuses unless `header.id` matches the requested session.
5. **Running sessions and parents are refused.** A live Agent (or a session with child sessions) yields a stable `live` / `has-children` code and the directory is untouched.
6. **`rename` only, never copy-then-delete.** `EXDEV`, `EPERM`, `EBUSY` are reported as `cross-volume` / `busy`; no fallback exists that could leave a duplicate or a partial copy.
7. **Serialized mutations.** One promise chain per service, plus a re-run of every preflight immediately before the move, which closes the window between the dialog and the action.
8. **No agent tool.** The Host half registers no tool at all. Only a person clicking the UI can delete a session; the model cannot.
9. **One endpoint, behind the standard fence.** `POST /api/session-trash` is mounted on `ctx.connection.fetch`, so it inherits Harness's Host/Origin and browser-credential checks. Bodies are capped at 64 KiB, operations are a closed set, and failures answer with a stable `code` plus a fixed sentence — never a filesystem path.
10. **The Host log is the source of truth.** Deletion drops the session from the workspace pin/archive sets and emits `api-session/removed`, which is the same event the sidebar already listens for; the row disappears immediately without any plugin-private state.

## Scope

- **Allowed:** any session that is not running and has no child sessions.
- **Refused:** a running session, a session with children, a directory that is not provably that session, anything outside the configured root.
- **Not touched:** attachments referenced by the deleted log (the attachment store is global and immutable), and the projection cache rows (they are hints only and self-heal).

## Verify

```bash
npm test     # node --test: paths, config, trash service, HTTP route
```

The suite builds throwaway session roots with real Zstandard logs, then asserts: read-only preflight, identity mismatch refusal, live/child refusals, atomic move, manifest round-trip, restore collision, purge containment (`../../etc` is rejected), corrupt-manifest handling, retention sweep, capacity refusal, serialized concurrency, and every HTTP status/code pair.

## Layout

```text
index.js            Host entry: settings, route, startup sweep
lib/paths.js        Path and identifier safety (pure functions)
lib/config.js       Config resolution and root disjointness
lib/sessions.js     Read-only location, header parsing, blockers
lib/trash.js        The only destructive module
lib/routes.js       The single POST endpoint
client.js           Sidebar row, confirmation dialog, settings page
locale/{en,zh}.json Plugin inventory metadata
```

## License

MIT. See [LICENSE](LICENSE).
