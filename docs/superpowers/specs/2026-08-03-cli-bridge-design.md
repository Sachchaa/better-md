# better-md CLI bridge — design

**Date:** 2026-08-03
**Status:** approved, ready for implementation planning

## Problem

better-md is a browser-only app. Files get in by drag-and-drop and out by download, so
using it on a file that already exists on disk means a manual round trip. The concrete
trigger: Claude Code writes every plan-mode plan to `~/.claude/plans/<slug>.md`, and
reading one in better-md currently requires locating and dragging it in, then exporting
and moving the result back if anything is edited.

## Goal

A `better-md` CLI that opens a real file from disk in the existing React app, with
edits saving back to that file.

## Non-goals

- A terminal renderer (ANSI/TUI). Considered and rejected: the space is well served by
  `glow`/`mdcat`, and `src/lib/markdown.ts` emits HTML with inline styles rather than an
  AST, so nothing could be reused without first refactoring it into a parser plus two
  backends. Not worth it for this goal.
- Refactoring `App.tsx` beyond what this feature needs. It is oversized (828 lines, class
  component) and worth splitting eventually, but that is a separate project.
- Recursive directory traversal, remote files, multi-user access.

## Decisions

| Decision          | Choice                                             | Rationale                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Write-back        | Explicit save (Cmd+S) with a dirty indicator       | Auto-save would mutate `~/.claude/plans` files on every stray keystroke                                                                                                                          |
| Targets           | file, directory, or `--plan`                       | One resolver, three entry points; `--plan` is the actual motivating case. `--plan` lists every plan in the sidebar with the newest one active, so switching between recent plans needs no re-run |
| External changes  | Auto-reload when clean, conflict banner when dirty | Plans update live as Claude revises them, without ever discarding local edits                                                                                                                    |
| Serving           | Standalone Node server over prebuilt `dist/`       | Zero runtime deps on Node 22; a Vite-plugin approach would ship a dev server as an end-user tool                                                                                                 |
| Lost-update guard | `mtime` comparison → HTTP 409                      | Cheap, and covers the real case (file rewritten between load and save)                                                                                                                           |

## Architecture

New top-level `cli/`, compiled as a second tsc target (Node/ESM) to `dist-cli/`.
`package.json` gains `"bin": {"better-md": "./dist-cli/index.js"}`. The React app keeps
its existing build; the CLI serves `dist/` as static files.

```
argv → args.ts → resolve.ts → Workspace ─┬→ server.ts → browser
                                          └→ watch.ts ──┘ (SSE)
```

| Module             | Responsibility                                                                                                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/args.ts`      | argv → `{target, plan, port, open}` using `node:util` `parseArgs`. Pure.                                                                                                                                                                                                                |
| `cli/resolve.ts`   | args → workspace descriptor `{root, files[], active}`. Single file (root = its parent, `files` = just it); directory (non-recursive `*.md`, `*.markdown`, `*.txt`, active = first alphabetically); `--plan` (root = `~/.claude/plans`, all plans listed, **active = newest by mtime**). |
| `cli/workspace.ts` | The only module that touches file contents: `list()`, `read()`, `write()`. All path confinement lives here.                                                                                                                                                                             |
| `cli/watch.ts`     | `fs.watch` on the root, debounced 50ms (editors write in bursts), emits change events.                                                                                                                                                                                                  |
| `cli/server.ts`    | `node:http`: static `dist/`, JSON API, SSE. Holds a `Workspace` and routes every document read/write through it; uses `fs` only for `distDir` assets.                                                                                                                                   |
| `cli/index.ts`     | Wiring, browser open, SIGINT teardown.                                                                                                                                                                                                                                                  |

`workspace.ts` is the security-critical unit and has no HTTP in it, so it can be tested
exhaustively — and it needs to be: implementation review found a browser-reachable write
escape here (a dangling symlink defeating the original `realpath`-based check), so its
confinement logic and tests are the deliverable, not boilerplate.

The invariant `server.ts` upholds is narrower than "no `fs` import" — it does import `fs`
to serve the built bundle. What it never does is derive a **document** path from a request
and hand it to `fs` itself: all user content moves through `Workspace`, while `distDir`
access is confined separately and never influenced by a workspace-relative path. Review
against that property, not against the absence of an import.

No new runtime dependencies — `http`, `fs`, `crypto`, and `parseArgs` are stdlib on
Node 22.

## Server contract

Binds `127.0.0.1` on an OS-assigned ephemeral port (`listen(0)`). A per-run token of 32
random bytes (`crypto.randomBytes`, hex) is generated at startup.

```
GET  /  (?t=<token>)      → index.html; the query param delivers the token
                            to the app but is not required to serve the page
GET  /assets/*            → static, confined to dist/
GET  /api/workspace       → {files:[{name,relPath}], active}
GET  /api/doc?path=<rel>  → {relPath, content, mtimeMs}
PUT  /api/doc             → body {relPath, content, baseMtimeMs}
                            → 200 {mtimeMs} | 409 when disk mtime ≠ baseMtimeMs
GET  /api/events          → SSE: {type:"changed"|"removed", relPath}
```

The change event carries no content or mtime — the client re-reads via `/api/doc`,
so there is one code path for loading a document rather than two. The client also
surfaces `connected` / `disconnected` events of its own when the stream opens or
drops, which is what drives the "not watching" indicator below.

### Security model

A localhost server that reads and writes files in the user's home directory is reachable
by every page open in the browser. Three independent layers:

1. **Bearer token** — `Authorization: Bearer <token>` required on every `/api/*` request.
   The app reads the token from `location.search` at boot and immediately strips it via
   `history.replaceState`, so it does not linger in the address bar or get copy-pasted.
   A custom header cannot be set by a cross-site `<form>` or `<img>`; those can only
   issue simple requests.
2. **Origin validation** — any request carrying an `Origin` that is not this server's own
   origin is rejected. This covers `fetch` from a hostile page, which can choose arbitrary
   paths but cannot forge `Origin`.
3. **Path confinement** — every `relPath` is resolved against the workspace root and
   rejected if it escapes, including after symlink resolution. A leaked token therefore
   exposes only the directory the CLI was pointed at.

Static assets and `index.html` are served without a token, since the bundle contains no
secrets. Loading the page without a valid token is fail-safe: `detectSource` finds no
token and the app boots in browser-only mode against sample documents.

## App-side changes

New logic goes into new files behind one interface, so `App.tsx` grows by roughly 60 lines
and is not restructured.

```ts
// src/lib/docSource.ts
export interface DocSource {
  canSave: boolean
  list(): Promise<FileDoc[]>
  read(relPath: string): Promise<{ content: string; mtimeMs: number | null }>
  save(relPath: string, content: string, baseMtimeMs: number | null): Promise<SaveResult>
  subscribe(cb: (ev: ChangeEvent) => void): () => void
}
```

- **`LocalDocSource`** — current behavior unchanged: seeded from `samples.ts`, in-memory,
  `canSave: false`, no-op `subscribe`. Drag-and-drop import and file export keep working
  exactly as they do today.
- **`ServerDocSource`** — calls the CLI API, holds the token, subscribes to SSE.
  `canSave: true`.
- **`src/lib/detectSource.ts`** — chooses one at boot based on the presence of the token
  in `location.search`. This is the only branch; the browser-only app behaves identically
  whether or not the CLI exists.
- **`App.tsx`** — gains a `source` prop and three state fields (`dirty`, `baseMtimeMs`,
  `conflict`) plus a Cmd+S handler.
- **`src/ui/ConflictBanner.tsx`** — new component, so the conflict UI does not add another
  inline JSX block to `App`.

On a 409, the app shows the same conflict banner as an external-change-while-dirty, with
keep-mine and take-theirs actions.

## Error handling

Every failure must be legible from a terminal:

- **Target missing** — `better-md: no such file or directory: <path>`, exit 1.
- **`--plan` with no `~/.claude/plans`** — `No plans directory found at ~/.claude/plans. Is Claude Code installed? Pass a file or directory instead.` exit 1. Same message shape when the directory exists but holds no markdown. This is the path that matters for users who do not have Claude Code installed.
- **Directory with no markdown** — names the directory and the extensions searched.
- **`--port` in use** — explicit `EADDRINUSE` message naming the port. Cannot occur without `--port`, since the default is `:0`.
- **Browser fails to open** — print the URL and keep serving. Never fatal.
- **Save fails** (permissions, disk full) — mapped to a safe, actionable status and message naming the client-supplied `relPath` (403 for a permission/read-only failure, 507 for out of space); never the raw OS message, which embeds the absolute path on disk. The app surfaces it and keeps the buffer dirty. Edits are never silently dropped.
- **SSE drops** — reconnect with backoff, and display a muted "not watching" indicator while disconnected rather than implying the view is live.
- **File deleted externally** — keep the buffer, mark it as no longer on disk; saving recreates it.

## Known limitations

Deliberate deferrals, not oversights:

- **Single `conflict` slot** — `App.state.conflict` holds at most one pending conflict. A
  second document changing on disk while the first conflict is still unresolved has its
  banner overwritten. Self-heals: resolving (or reloading) either document re-runs the
  same check, so nothing is silently lost, and a workspace of real files rarely has two
  simultaneous unresolved conflicts.
- **A file created after boot does not appear until restart** — the workspace descriptor
  is resolved once, at CLI startup; `watch.ts` notifies on changes to files it already
  knows about, not on new arrivals. Restarting the CLI re-resolves the directory.
- **No SSE heartbeat** — `/api/events` relies on the underlying TCP connection dropping to
  detect disconnection. A silently wedged intermediary (rare on `127.0.0.1`, since there
  is nothing to wedge) could delay the "not watching" indicator.
- **Hardlinks are not detected** — path confinement is necessarily path-based. A hardlink
  inside the workspace pointing at a file outside it resolves to a distinct inode with no
  path to inspect, unlike a symlink, so `Workspace`'s checks do not see it and a write
  goes straight through to the linked-to file.
- **`Workspace.write` truncates and writes in place, rather than write-temp-then-rename.**
  Considered and rejected: `rename` onto the resolved path would replace the target
  inode, which breaks any other hardlink inside the workspace root pointing at the same
  file (they would keep the old inode's contents, not the new write) and drops
  filesystem extended attributes the original inode carried. Truncate-then-write keeps
  the same inode, so both are preserved. This is a deliberate trade against a shorter
  window where a reader could observe a partially-written file, not an oversight.

## Testing

Vitest for everything except the one browser test.

- **`workspace.ts`** — the security core, tested exhaustively: `../` traversal, absolute
  paths, URL-encoded traversal (`%2e%2e`), null bytes, and symlinks resolving outside the
  root. All must reject.
- **`args.ts` / `resolve.ts`** — pure unit tests over a temp-dir fixture, including
  newest-by-mtime selection for `--plan`.
- **`server.ts`** — integration tests against a real server on `:0`: missing token → 401,
  foreign `Origin` → 403, traversal path → 400, stale `baseMtimeMs` → 409, plus a
  happy-path read/write round trip.
- **`ServerDocSource`** — against a stubbed `fetch`.
- **End-to-end** — one Playwright spec (new devDependency): spawn the CLI against a temp
  directory, load the page, type, press Cmd+S, and assert the file on disk changed. This
  covers the full bridge, which is the part most likely to break silently.
- `markdown.test.ts` is untouched.

## Open-sourcing

The repo will be made public. Ordering matters: **publish only after the security model
above is implemented**, because installs cannot be recalled.

**Status (2026-08-03): items 1-3 below are done; item 4 needs a final pass before
publishing.** `.agents/skills/` is untracked (`git ls-files` shows zero tracked files
under it), the MIT `LICENSE` is added, and `README.md`'s link to the private Claude
Design project is fixed.

Commit authorship (item 4) was rewritten on `main`/`origin/main` (`git log main
--format='%ae' | sort -u` shows only the personal address). It is **not** yet clean on
the branch that implements this feature: roughly half of its commits were made under
the local git config's work address, so `git log --format='%ae' | sort -u` on this
branch currently returns two addresses, not one. Separately, three refs left over from
earlier history rewrites — `refs/original/refs/heads/main` and tags
`pre-rewrite-backup` / `pre-email-fix` — still point at pre-rewrite commits, including
one that still contains the un-purged `.agents/skills/` tree (79 files, among them the
license-less `vercel-react-best-practices` skill) and two older author addresses.
Pushing tags or `--all` before deleting those refs would undo both the purge and the
authorship rewrite the moment the repo goes public. The repo remains **private**
pending completion of this security-model feature; publishing is a separate, explicit
step, and item 4 needs a final authorship pass (this branch plus the leftover backup
refs) as part of it, not before.

Pre-publish tasks:

1. **Untrack `.agents/skills/`** — 79 of 104 tracked files are vendored third-party skills
   from `vercel-labs/skills`, `anthropics/skills`, and `vercel-labs/agent-skills`.
   `frontend-design` is Apache 2.0, but `vercel-react-best-practices` ships no license at
   all. Add `.agents/skills/` to `.gitignore` and rely on `skills-lock.json` to restore
   them from source.
2. **Add a LICENSE** — MIT. Without one the repo is public but not usable.
3. **Fix `README.md:4`** — it links to a private `claude.ai/design/p/<uuid>` project, which
   404s for others and exposes an internal project ID. Reword to "originally prototyped in
   Claude Design."
4. **Decide commit authorship** — the initial commits were authored with a work email
   address on what is a personal project. Rewriting is trivial while the repo is private
   and effectively permanent after publishing. Recommendation: rewrite to a personal
   address before going public. This is the author's call. (Done — the whole history now
   carries one personal identity. Note the failure mode: with no repo-local `user.email`,
   every new commit silently reverts to the global one, which happened twice and was
   caught by a pre-publish audit rather than by anything automatic.)

A scan found no secrets, absolute paths, or other personal references in tracked files.

`src/lib/markdown.ts` needs no hardening for this: `esc()` runs first on every text path
and there is no raw-HTML passthrough, so raw markup in a source file renders as literal
text. The new attack surface is entirely the server's file access.
