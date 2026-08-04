# better-md

**Markdown Dashboard** — a clean, two-way Markdown editor with a live, editable preview.
Originally prototyped in Claude Design, then implemented as a real app.

## Stack

- **pnpm** — package manager
- **Vite** + **React 19** — app + dev server
- **TypeScript** (strict)
- **Tailwind CSS v4** — styling (theme tokens driven by CSS variables)

## Features

- Bidirectional sync — edit Markdown source on the left or the rendered preview on the right
- Formatting toolbar (headings, bold/italic/strike/code, lists, quote, link) + `Tab` indent
- Three layouts: **Studio** (sidebar + split), **Tabs**, **Focus** (single pane)
- Light / dark themes with a configurable accent color
- Multi-file management with drag-and-drop `.md` / `.markdown` / `.txt` import
- Synced scrolling, live word/char/line counts, read-time estimate
- Export to Markdown (`.md`) or PDF (via print)

## Getting started

```bash
pnpm install
pnpm dev          # start the dev server
pnpm build        # typecheck (tsc) + production build (dist/)
pnpm build:cli    # embed dist/ into the CLI, compile it to dist-cli/, and make
                  # the entry point executable
pnpm binaries     # single-file executables into release/ (add --all for every
                  # platform; needs network to fetch official Node builds)
pnpm preview      # preview the production build

pnpm test         # run unit tests (Vitest)
pnpm test:e2e     # Playwright end-to-end tests — needs `pnpm build` AND
                  # `pnpm build:cli` first, since it spawns dist-cli/index.js
pnpm lint         # ESLint
pnpm format       # Prettier (write)
```

## Try it without installing

<https://playground.better-md.dev> runs the editor in your browser with sample documents.

Only sample documents, though — opening your own files is precisely the part that needs the
local command, since a page served from the internet cannot read your disk. That is what
the CLI below exists for.

## Install

```bash
curl -fsSL https://better-md.dev/install.sh | sh
```

Read it first if you'd rather not pipe a script you haven't seen — it is served as plain
text, so <https://better-md.dev/install.sh> opens in a browser. The
[raw copy on GitHub](https://raw.githubusercontent.com/Sachchaa/better-md/main/install.sh) is
identical.

**No Node.js required** — the runtime is embedded in the binary, and so is the editor
itself. One file, nothing else to install.

The installer picks the right build for your platform, verifies it against the published
`SHA256SUMS` (and refuses to install if that does not match, or if the checksums are
missing), and drops it in `~/.local/bin` as `better-md`, plus `btr-md` as a shorter alias.

Prebuilt for macOS and Linux, arm64 and x64.

```bash
BETTER_MD_VERSION=v0.1.0 sh install.sh   # pin a release
BETTER_MD_INSTALL=/usr/local/bin sh …    # choose the directory
```

To uninstall, delete `better-md` and `btr-md` from your install directory. There is
nothing else on disk.

## Opening files from disk

```bash
better-md notes.md   # open a single file
better-md ./docs     # open every markdown file in a directory
better-md --plan     # open Claude Code's plans (~/.claude/plans), newest active
```

`btr-md` is a shorter alias for the same binary, and each name reports itself in `--help`
and in error messages.

Running from a checkout instead of an install:

```bash
pnpm build && pnpm build:cli   # build:cli embeds dist/ into the CLI
node dist-cli/index.js notes.md
```

Edits save back to the real file with `Cmd/Ctrl+S`. See **How it works** below for what
happens when the file changes underneath you.

## How it works

better-md is a browser app, and browsers cannot open arbitrary files from disk. The CLI
closes that gap by becoming a small local server the app talks to.

```
better-md --plan
   │
   ├─ resolve one directory as the workspace          cli/resolve.ts
   ├─ start http://127.0.0.1:<ephemeral port>         cli/server.ts
   │    ├─ serves the editor from assets embedded in the binary
   │    ├─ GET/PUT /api/doc     documents, via the confinement gateway
   │    └─ GET     /api/events  change notifications (SSE)
   ├─ watch the workspace, debounced 50ms             cli/watch.ts
   └─ open your browser at  .../?t=<token>
```

Everything is scoped to that one directory. A fresh 32-byte token is minted per run and
never persisted.

The editor's own files are embedded at build time rather than read from disk, which is
what makes a single-file binary possible — and it removes a whole class of bug as a side
effect: the static route resolves no paths and opens no files, so a request either names
an embedded asset or it 404s.

### Boot: which mode am I in?

The launch URL carries `?t=<token>`. On boot the app reads it, chooses a document source,
and immediately strips it from the address bar so it never lands in your history or a
copy-pasted link.

- **Token present** → the disk-backed source. Documents come from the workspace and
  `Cmd/Ctrl+S` writes real files.
- **No token** → the original browser-only app with its sample documents.

That second branch is deliberate, not incidental. Open the served page without the token —
a bookmark, a retyped URL, a second tab — and you get the plain editor, never a broken
one. It is also why the page itself is served without auth: only `/api/*` is gated.

Both modes go through one interface (`DocSource`), so the editor itself has no idea which
it is talking to.

### Saving

Save is explicit: nothing is written until you press `Cmd/Ctrl+S`. Auto-save would rewrite
plan files on every stray keystroke.

Each save carries the modification time the document was loaded at. If disk has moved
since, the write is refused and you choose:

- **Keep mine** — adopt the on-disk timestamp, so your next save goes through.
- **Take theirs** — replace your buffer with the on-disk version.

If the file was _deleted_ rather than changed, there is no "theirs" to take. The app says
so and keeps your buffer, because that buffer is now the only copy of it.

### Staying in sync

The CLI watches the workspace and streams changes over SSE, so a plan updates in the
editor while an agent is rewriting it:

- **No unsaved edits** → the document refreshes silently.
- **Unsaved edits** → a conflict banner. Nothing is overwritten in either direction until
  you pick.

The watcher sees the app's own writes too, so every save would otherwise echo back looking
like an external change. Those are filtered out by comparing timestamps — a save never
raises a conflict against itself.

### When something goes wrong

- **The stream drops** → a "Not watching for changes" notice appears, and reconnecting
  re-reads the workspace so anything that changed during the outage is picked up.
- **The CLI was restarted** → the page is holding a dead token. Rather than retrying
  forever, the app tells you to reopen the URL the new run printed.
- **A document cannot be read** — permissions, a broken symlink, deleted between startup
  and load — it is reported by name and the rest of the workspace still opens.
- **Unsaved edits at close** → the browser warns you before discarding them.

Renaming and deleting act on the editor only, so those controls are hidden in disk-backed
mode rather than implying a change that never reaches the file.

## Project structure

```
index.html          # entry HTML (loads /src/main.tsx)
src/
  main.tsx          # React root
  App.tsx           # Markdown Dashboard component (UI + state)
  App.test.tsx      # App-level tests: the source is a fake DocSource, not a mock
  types.ts          # shared TypeScript types
  index.css         # Tailwind import + theme tokens (light/dark CSS variables)
  lib/
    markdown.ts     # Markdown <-> HTML conversion (URL-sanitized)
    markdown.test.ts# unit tests for the markdown engine
    samples.ts      # seed documents
    id.ts           # collision-free file ids
    docSource.ts    # DocSource interface + LocalDocSource (browser-only, in-memory)
    serverDocSource.ts # DocSource backed by the CLI's HTTP API + SSE
    conflictResolution.ts # pure helpers behind the save/reload conflict logic
    detectSource.ts  # chooses Local vs Server at boot from the URL token
  ui/
    classes.ts      # shared Tailwind class fragments
    ConflictBanner.tsx # conflict / save-error banners
cli/                 # the CLI — argv to a served, token-guarded HTTP API
  args.ts           # argv -> {target, plan, port, open}
  programName.ts    # which alias was invoked, so help/errors name it correctly
  resolve.ts        # args -> workspace descriptor {root, files[], active}
  workspace.ts      # the only module that touches file contents; path confinement lives here
  watch.ts          # fs.watch, debounced, emits change events
  server.ts         # node:http embedded-asset serving + JSON API + SSE
  index.ts          # wiring, browser open, SIGINT teardown
  assets.generated.ts # GENERATED: the editor bundle, embedded (gitignored)
scripts/
  embed-assets.mjs  # dist/ -> cli/assets.generated.ts
  build-binaries.mjs # single-file executables via Node SEA, per platform
install.sh          # the one-line installer (downloads + verifies a release)
public/
  site/index.html   # better-md.dev landing page — hand-written, no build step
e2e/
  cli-bridge.spec.ts # Playwright: spawns the CLI, drives the browser, asserts disk state
  site.spec.ts      # Playwright: the landing page renders and its links are live
vercel.json         # deploy config: host-based routing + install.sh content type
vite.config.ts      # Vite + React + Tailwind plugins
vitest.workspace.ts # test config: separate `app` (jsdom) and `cli` (node) projects
playwright.config.ts # end-to-end test config
eslint.config.js    # ESLint flat config
tsconfig*.json      # TypeScript project config (strict), one per build target
```

## Deployment

One Vercel project serves three things out of a single `dist/`, routed by hostname in
`vercel.json`:

| URL                        | Serves                       | From                   |
| -------------------------- | ---------------------------- | ---------------------- |
| `better-md.dev`            | the landing page             | `dist/site/index.html` |
| `playground.better-md.dev` | the editor, sample docs      | `dist/index.html`      |
| `better-md.dev/install.sh` | the installer, as plain text | `dist/install.sh`      |

The rewrite order matters: the `playground` host is matched first, and everything else —
the apex, `www`, and every preview deployment — falls through to the landing page. So a
preview URL shows the site at `/`, which is what you want to review; the editor stays
reachable on any host at the explicit `/index.html`.

`index.html` remains the **editor**, deliberately. The CLI embeds all of `dist/` and serves
the key `index.html` at `/`, so making the landing page the root would mean
`better-md --plan` opening a marketing page. Keeping the site at its own path leaves the
binary's contract untouched and confines the split to hosting. `scripts/embed-assets.mjs`
drops `site/` from the embedded manifest, and `scripts/smoke-binary.mjs` asserts both
halves of that: the website is absent from the binary, and `/` is still the editor.

The landing page is hand-written HTML with inline CSS rather than a second Vite entry — a
marketing page should not carry a build pipeline, and staying out of the editor's bundle
graph is what makes the exclusion above trivially true. Its theme tokens are copied from
`src/index.css`, so the two read as one product.

## Security note

User markdown is rendered into the editable preview via `innerHTML` and can be
**imported from arbitrary `.md` files** (drag-and-drop). `src/lib/markdown.ts`
therefore escapes all interpolated text/attributes and blocks `javascript:`,
`vbscript:` and non-image `data:` URLs. See `markdown.test.ts` for the XSS cases.

### CLI security model

The CLI runs a short-lived HTTP server on `127.0.0.1` at an ephemeral port. Because
any page in your browser can reach a localhost port, three independent layers guard
the file API:

1. **Bearer token** — a fresh 32-byte token per run, required on every `/api/*`
   request. It arrives via the launch URL and is stripped from the address bar
   immediately. Custom headers cannot be forged by cross-site form or image requests.
2. **Origin validation** — requests carrying a foreign `Origin` are refused.
3. **Path confinement** — only bare filenames with a `.md`, `.markdown`, or `.txt`
   extension resolving inside the workspace root are readable or writable, symlinks
   included.

The editor's own assets are embedded in the binary, so serving them involves no path
resolution and no filesystem access at all — that route cannot be walked out of.

Confinement is path-based, so a **hardlink** inside the workspace pointing at a file
outside it is not detected — unlike a symlink, it resolves to a distinct inode with no
path to inspect, and writes to it go straight through to the linked-to file.

Saves are guarded by an mtime check: if the file changed on disk since it was loaded,
the write is refused and you choose which version wins.
