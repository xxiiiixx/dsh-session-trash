# Changelog

All notable changes to this plugin, in reverse chronological order. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-10-19

First public release: a recoverable session trash for DeepSeek Harness Desktop.

### Added

- **Move to trash** in a session's sidebar `…` menu, with a confirmation dialog
  naming the title, original path and size.
- **Settings → Session Trash**: list deleted sessions, restore one, purge one, or
  empty the trash.
- A startup retention sweep that removes entries older than `retentionDays`
  (default 30) without a UI notification.
- A derived subagent session (`origin: subagent`) that has stopped travels with
  its parent into the same trash entry and returns with it on restore. Forks
  (`isSeeded`) stay put and never block their origin.
- `POST /api/session-trash` on the Host's authenticated fetch channel, answering
  with stable failure codes (`live`, `child-running`, `has-children`,
  `cross-volume`, `busy`, `already-exists`, `corrupt`, `unavailable`, …).
- A **Disclaimer** section in both READMEs and a notice in `LICENSE`: this plugin
  deletes data, is provided as is under the MIT license, and is not affiliated
  with DeepSeek. The author is not liable for lost sessions or unreconstructable
  work.

### Changed during the release

These were found by using the plugin and fixed before the first tag.

- **Liveness no longer blocks stopped sessions.** The check used to refuse any
  session with a resident Agent, so a session you had already stopped could not
  be deleted. It now reads `agent.status === 'running'`, exactly as the shipped
  archive action does, and no longer consults `sessions.get()` — which answers
  "is this Session attached", true for nearly every row, and says nothing about
  running work. An Agent that cannot report a status is still treated as
  running, so the plugin never guesses.
- **The menu row is styled for the whole run.** Its stylesheet used to be a
  `<style>` element rendered by the dialog and the settings page, so the menu row
  had no styles until a dialog had mounted and appeared as the browser's default
  grey button. The stylesheet is now injected once in `apply()` through
  `ctx.effect` and removed on unload.
- **The row and its buttons match the host exactly.** The menu row and the
  dialog buttons copy `MenuItemButton` and `Button` geometry from the shipped
  primitives; the destructive confirm is the host's outline-with-red-text
  pattern, not a red border. A script diffs the copy against the host's own
  stylesheet declaration by declaration.
- **An unreadable session list says so.** It used to report `has-children`,
  which told users their session had children when the listing had merely
  failed. It now reports `activity-unknown` and still refuses the delete.

### Security

- No filesystem path is ever accepted from the client: the wire carries a
  session id or a trash entry id, and the Host resolves it against its own roots.
- Identifiers are whitelisted and resolved paths are `realpath`-checked for
  containment; a directory must prove its identity through the log's header
  before it is moved.
- Mutations are serialized, preflights are re-run immediately before a move, and
  a partial failure restores everything already moved.
- No agent tool is registered: only a person clicking the UI can delete a
  session.

[Unreleased]: https://github.com/xxiiiixx/dsh-session-trash/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/xxiiiixx/dsh-session-trash/releases/tag/v0.1.0
