/**
 * Move the built editor from `dist/index.html` to `dist/app/index.html`, leaving
 * no file at the root of `dist/`.
 *
 * This exists for one reason. Vercel evaluates `vercel.json` rewrites *after* the
 * filesystem, so a real `dist/index.html` is served at `/` and a host-based rule
 * for that path can never fire — the first attempt at this deployed cleanly and
 * still showed the editor on better-md.dev. With the root empty, both rewrites
 * apply: the landing page for better-md.dev, the editor for
 * playground.better-md.dev.
 *
 * Only the *built output* moves. Vite's entry stays at `./index.html`, so
 * `pnpm dev` still serves the editor at `/`.
 *
 * The CLI is unaffected: `scripts/embed-assets.mjs` embeds this file under the
 * key `index.html`, which is what `cli/server.ts` serves at `/`. Vite emits
 * absolute asset URLs (`/assets/…`), so they resolve from either location.
 *
 * Run by `pnpm build`, after `vite build`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const DIST = path.resolve(import.meta.dirname, '..', 'dist')
const FROM = path.join(DIST, 'index.html')
const TO = path.join(DIST, 'app', 'index.html')

const moved = await fs
  .stat(FROM)
  .then(() => true)
  .catch(() => false)

if (!moved) {
  // Already laid out (a repeat run), or there is no build to lay out. Only the
  // second case is a problem, and it is the caller's to report.
  const already = await fs
    .stat(TO)
    .then(() => true)
    .catch(() => false)
  process.stdout.write(
    already
      ? 'dist/ already laid out for deployment — nothing to do\n'
      : `nothing to lay out: no ${path.relative(process.cwd(), FROM)}\n`
  )
  process.exit(0)
}

await fs.mkdir(path.dirname(TO), { recursive: true })
await fs.rename(FROM, TO)

process.stdout.write('laid out dist/: editor -> app/index.html, root left empty for routing\n')
