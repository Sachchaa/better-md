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
pnpm build:cli    # compile the CLI (dist-cli/) and chmod its entry point so the
                  # package.json `bin: better-md` is directly executable
pnpm preview      # preview the production build

pnpm test         # run unit tests (Vitest)
pnpm test:e2e     # Playwright end-to-end tests — needs `pnpm build` AND
                  # `pnpm build:cli` first: it spawns dist-cli/index.js, which
                  # serves dist/
pnpm lint         # ESLint
pnpm format       # Prettier (write)
```

## Opening files from disk

Build both targets once, then point the CLI at a file or directory:

```bash
pnpm build                     # dist/ — what the CLI serves as static assets
pnpm build:cli                 # dist-cli/ — the CLI itself
node dist-cli/index.js notes.md
```

- `better-md <file.md>` — open a single file
- `better-md <directory>` — open every markdown file in a directory
- `better-md --plan` — open Claude Code's plans from `~/.claude/plans`, newest first

Edits save back to the real file with `Cmd/Ctrl+S`. If the file changes on disk while you
have no unsaved edits, the view refreshes automatically; if you do have unsaved edits, a
banner lets you keep yours or take theirs.

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
cli/                 # the `better-md` CLI — argv to a served, token-guarded HTTP API
  args.ts           # argv -> {target, plan, port, open}
  resolve.ts        # args -> workspace descriptor {root, files[], active}
  workspace.ts      # the only module that touches file contents; path confinement lives here
  watch.ts          # fs.watch, debounced, emits change events
  server.ts         # node:http static serving + JSON API + SSE
  index.ts          # wiring, browser open, SIGINT teardown
e2e/
  cli-bridge.spec.ts # Playwright: spawns the CLI, drives the browser, asserts disk state
vite.config.ts      # Vite + React + Tailwind plugins
vitest.workspace.ts # test config: separate `app` (jsdom) and `cli` (node) projects
playwright.config.ts # end-to-end test config
eslint.config.js    # ESLint flat config
tsconfig*.json      # TypeScript project config (strict), one per build target
```

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

Confinement is path-based, so a **hardlink** inside the workspace pointing at a file
outside it is not detected — unlike a symlink, it resolves to a distinct inode with no
path to inspect, and writes to it go straight through to the linked-to file.

Saves are guarded by an mtime check: if the file changed on disk since it was loaded,
the write is refused and you choose which version wins.
