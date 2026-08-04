/**
 * Exercise a built `better-md` binary the way a user would.
 *
 * This exists because the release binaries are cross-compiled on one platform
 * and run on others, so "it compiled" is not evidence that it works. The macOS
 * builds were checked by hand; this makes the same checks runnable anywhere,
 * which is what lets CI cover the Linux ones natively.
 *
 * Deliberately runs against the binary over HTTP rather than importing modules:
 * the thing being tested is the packaged artifact, including its embedded
 * runtime and embedded editor assets. It also runs from a directory with no
 * `dist/` in sight, so serving the editor proves the assets really are embedded.
 *
 * Usage: node scripts/smoke-binary.mjs <path-to-binary>
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

if (!process.argv[2]) throw new Error('usage: node scripts/smoke-binary.mjs <path-to-binary>')
// Absolute: the server is deliberately spawned from a temp cwd (so no dist/ can
// be nearby), which would break a relative path like ./release/better-md-linux-x64.
const binary = path.resolve(process.argv[2])
await fs.access(binary).catch(() => {
  throw new Error(`no such binary: ${binary}`)
})

const checks = []
let failed = 0

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  if (!ok) failed++
  process.stdout.write(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`)
}

/** Run the binary, resolving with the tokenised URL it prints. */
function start(args, env = {}) {
  const child = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Run from a temp cwd so nothing can accidentally resolve a dist/ next to us.
    cwd: os.tmpdir(),
    env: { ...process.env, ...env },
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`binary printed no URL within 20s (args: ${args.join(' ')})`))
    }, 20_000)
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => {
      out += c.toString('utf8')
      const m = /(http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+)/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve({ child, url: m[1], out })
      }
    })
    child.stderr.on('data', (c) => {
      err += c.toString('utf8')
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`binary exited early (code ${code})\nstdout: ${out}\nstderr: ${err}`))
    })
  })
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'btr-smoke-'))
const ws = path.join(base, 'ws')
await fs.mkdir(ws)
await fs.writeFile(path.join(ws, 'note.md'), '# original\n', 'utf8')

let server
try {
  // --- it starts and describes itself --------------------------------------
  const help = spawn(binary, ['--help'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const helpText = await new Promise((resolve) => {
    let t = ''
    help.stdout.on('data', (c) => (t += c.toString('utf8')))
    help.stderr.on('data', (c) => (t += c.toString('utf8')))
    help.on('exit', () => resolve(t))
  })
  check('--help names the program', helpText.includes('better-md'), helpText.split('\n')[0])

  // --- it serves the embedded editor with no dist/ anywhere ----------------
  server = await start(['--no-open', ws])
  const origin = new URL(server.url).origin
  const token = new URL(server.url).searchParams.get('t')

  const root = await fetch(origin)
  const rootBody = await root.text()
  check('serves the editor', root.status === 200, `HTTP ${root.status}`)
  check('editor assets are embedded', rootBody.includes('id="root"'))

  const scriptMatch = /assets\/[^"']+\.js/.exec(rootBody)
  if (scriptMatch) {
    const js = await fetch(`${origin}/${scriptMatch[0]}`)
    const bytes = (await js.arrayBuffer()).byteLength
    check('serves the embedded bundle', js.status === 200 && bytes > 10_000, `${bytes} bytes`)
  } else {
    check('serves the embedded bundle', false, 'no script tag found in index.html')
  }

  // The website lives in dist/ too, so the binary would happily embed and serve
  // it if the exclusion in embed-assets.mjs regressed. Two things are asserted:
  // the marketing page is absent, and `/` is still the EDITOR — the failure mode
  // that matters is `better-md --plan` opening a landing page.
  const site = await fetch(`${origin}/site/index.html`)
  check('does not embed the website', site.status === 404, `HTTP ${site.status}`)
  check('root is the editor, not the landing page', !rootBody.includes('Open the playground'))

  // --- the API is gated ----------------------------------------------------
  const noAuth = await fetch(`${origin}/api/workspace`)
  check('API refuses an unauthenticated request', noAuth.status === 401, `HTTP ${noAuth.status}`)

  const reversed = token.split('').reverse().join('')
  const wrongAuth = await fetch(`${origin}/api/workspace`, {
    headers: { authorization: `Bearer ${reversed}` },
  })
  check(
    'API refuses a same-length wrong token',
    wrongAuth.status === 401,
    `HTTP ${wrongAuth.status}`
  )

  const badOrigin = await fetch(`${origin}/api/workspace`, {
    headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
  })
  check('API refuses a foreign Origin', badOrigin.status === 403, `HTTP ${badOrigin.status}`)

  const auth = { authorization: `Bearer ${token}` }
  const listed = await fetch(`${origin}/api/workspace`, { headers: auth })
  const listing = await listed.json()
  check('API lists the workspace', listed.status === 200 && listing.active === 'note.md')

  // --- it writes to real files ---------------------------------------------
  const read = await (await fetch(`${origin}/api/doc?path=note.md`, { headers: auth })).json()
  const put = await fetch(`${origin}/api/doc`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      relPath: 'note.md',
      content: '# written by the smoke test\n',
      baseMtimeMs: read.mtimeMs,
    }),
  })
  const onDisk = await fs.readFile(path.join(ws, 'note.md'), 'utf8')
  check('save reaches disk', put.status === 200 && onDisk.includes('smoke test'), onDisk.trim())

  // --- and refuses to clobber ---------------------------------------------
  const stale = await fetch(`${origin}/api/doc`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ relPath: 'note.md', content: 'clobber', baseMtimeMs: 1 }),
  })
  const afterStale = await fs.readFile(path.join(ws, 'note.md'), 'utf8')
  check(
    'stale mtime is refused with 409',
    stale.status === 409 && !afterStale.includes('clobber'),
    `HTTP ${stale.status}`
  )

  // --- traversal cannot reach the workspace through the asset route --------
  const traversal = await fetch(`${origin}/assets/..%2f..%2fnote.md`)
  check('asset route does not serve workspace files', traversal.status === 404)

  server.child.kill('SIGTERM')
  server = null

  // --- --plan picks the NEWEST plan, not the first alphabetically ----------
  const home = path.join(base, 'home')
  const plans = path.join(home, '.claude', 'plans')
  await fs.mkdir(plans, { recursive: true })
  await fs.writeFile(path.join(plans, 'aaa-oldest.md'), '# old\n', 'utf8')
  await fs.writeFile(path.join(plans, 'zzz-newest.md'), '# new\n', 'utf8')
  const old = new Date(Date.now() - 86_400_000)
  await fs.utimes(path.join(plans, 'aaa-oldest.md'), old, old)

  const planRun = await start(['--no-open', '--plan'], { HOME: home })
  const planOrigin = new URL(planRun.url).origin
  const planToken = new URL(planRun.url).searchParams.get('t')
  const planList = await (
    await fetch(`${planOrigin}/api/workspace`, {
      headers: { authorization: `Bearer ${planToken}` },
    })
  ).json()
  check(
    '--plan activates the newest plan',
    planList.active === 'zzz-newest.md',
    `active=${planList.active}`
  )
  planRun.child.kill('SIGTERM')
} finally {
  if (server) server.child.kill('SIGKILL')
  await fs.rm(base, { recursive: true, force: true })
}

process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`)
if (failed > 0) {
  process.stdout.write(`${failed} FAILED\n`)
  process.exit(1)
}
