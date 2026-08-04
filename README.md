# better-md

**Markdown Dashboard** — a clean, two-way Markdown editor with a live, editable preview.
Originally prototyped in Claude Design, then implemented as a real app.

## Stack

- **pnpm** — package manager
- **Vite** + **React 18** — app + dev server
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
pnpm build        # typecheck (tsc) + production build
pnpm preview      # preview the production build

pnpm test         # run unit tests (Vitest)
pnpm lint         # ESLint
pnpm format       # Prettier (write)
```

## Opening files from disk

Build once, then point the CLI at a file or directory:

```bash
pnpm build                     # the CLI serves the built bundle
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
  types.ts          # shared TypeScript types
  index.css         # Tailwind import + theme tokens (light/dark CSS variables)
  lib/
    markdown.ts     # Markdown <-> HTML conversion (URL-sanitized)
    markdown.test.ts# unit tests for the markdown engine
    samples.ts      # seed documents
    id.ts           # collision-free file ids
  ui/
    classes.ts      # shared Tailwind class fragments
vite.config.ts      # Vite + React + Tailwind plugins
vitest.config.ts    # test config (jsdom)
eslint.config.js    # ESLint flat config
tsconfig*.json      # TypeScript project config (strict)
```

## Security note

User markdown is rendered into the editable preview via `innerHTML` and can be
**imported from arbitrary `.md` files** (drag-and-drop). `src/lib/markdown.ts`
therefore escapes all interpolated text/attributes and blocks `javascript:`,
`vbscript:` and non-image `data:` URLs. See `markdown.test.ts` for the XSS cases.
