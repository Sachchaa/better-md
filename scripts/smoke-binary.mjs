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
import net from 'node:net'
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

  // --- sessions ------------------------------------------------------------
  // The listing has to work against a real detached server, and must never carry
  // the bearer token the record holds. Its own HOME so the developer's real
  // ~/.better-md is never read, listed or pruned by a test run.
  {
    const sessionHome = path.join(base, 'sessions-home')
    await fs.mkdir(sessionHome, { recursive: true })
    const env = { HOME: sessionHome }

    const empty = await capture(['--sessions'], env)
    check(
      '--sessions says so when nothing is running',
      empty.out.includes('No sessions running'),
      empty.out.split('\n')[0]
    )

    const detached = spawn(binary, ['--detach', '--no-open', ws], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    const detachedUrl = await new Promise((resolve) => {
      let out = ''
      detached.stdout.on('data', (d) => {
        out += d.toString('utf8')
        if (out.includes('http://')) resolve(out.trim().split('\n').pop())
      })
      detached.on('exit', () => resolve(out.trim().split('\n').pop() ?? ''))
    })

    const listed = await capture(['--sessions'], env)
    check('--sessions lists a detached server', listed.out.includes('1 session running'), listed.out.split('\n')[0])
    check('--sessions names the workspace', listed.out.includes(ws))
    check(
      '--sessions never prints the token',
      !/\?t=|[a-f0-9]{40}/.test(listed.out),
      listed.out.replace(/\n/g, ' ').slice(0, 60)
    )

    // Killed hard, so the record survives its server: the next listing must prune
    // it rather than report a server that is gone.
    const pid = Number(/pid (\d+)/.exec(listed.out)?.[1])
    check('--sessions reports the pid', Number.isInteger(pid) && pid > 0, `pid=${pid}`)
    if (Number.isInteger(pid)) process.kill(pid, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 300))
    const pruned = await capture(['--sessions'], env)
    check(
      '--sessions prunes a record whose server is gone',
      pruned.out.includes('No sessions running'),
      pruned.out.split('\n')[0]
    )
    void detachedUrl
  }

  // --- terminal mode, one-shot ---------------------------------------------
  // A long plan rendered to a pipe, with the reader closing it immediately.
  // `better-md plan.md -t | less` and quitting less early is exactly this, and it
  // used to print a Node stack trace: the unhandled EPIPE on stdout.
  {
    // Its own directory: added to `ws` it would change which file the server
    // reports as active, and the workspace listing check asserts that exactly.
    const pipeDir = path.join(base, 'pipe')
    await fs.mkdir(pipeDir, { recursive: true })
    const long = path.join(pipeDir, 'long-plan.md')
    await fs.writeFile(
      long,
      Array.from(
        { length: 4000 },
        (_, i) =>
          `## Section ${i}\n\nBody text for section ${i}, long enough to wrap when rendered.\n\n- [x] done\n- [ ] todo`
      ).join('\n\n'),
      'utf8'
    )

    const piped = spawn(binary, ['--terminal', long], { stdio: ['ignore', 'pipe', 'pipe'] })
    const closedEarly = await new Promise((resolve) => {
      let err = ''
      let firstLine = ''
      piped.stderr.on('data', (d) => (err += d.toString('utf8')))
      piped.stdout.once('data', (d) => {
        firstLine = d.toString('utf8').split('\n')[0]
        // Destroying the read end is what `head` and a quit pager both do.
        piped.stdout.destroy()
      })
      piped.on('exit', (code) => resolve({ err, code, firstLine }))
    })
    check(
      'terminal mode renders to a pipe',
      closedEarly.firstLine.includes('Section 0'),
      closedEarly.firstLine
    )
    check(
      'a closed pipe is not an error',
      closedEarly.err === '',
      closedEarly.err.split('\n')[0] || '(clean)'
    )
    check(
      'exits cleanly when the reader goes away',
      closedEarly.code === 0,
      `exit ${closedEarly.code}`
    )
  }

  /** Run the binary to completion, capturing the streams separately. */
  function capture(args, env = {}) {
    const c = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    return new Promise((resolve) => {
      let out = '',
        err = ''
      c.stdout.on('data', (d) => (out += d))
      c.stderr.on('data', (d) => (err += d))
      c.on('exit', (code) => resolve({ out, err, code }))
    })
  }

  // Deliberately offline. --check-updates and update reach GitHub, which
  // rate-limits unauthenticated CI addresses; asserting on them here would make
  // this suite fail for reasons that have nothing to do with the binary. Their
  // logic is covered by cli/update.test.ts with an injected fetch.
  const version = await capture(['--version'])
  check(
    '--version prints "<name> <semver>" on stdout, exit 0',
    version.code === 0 && /^better-md \d+\.\d+\.\d+/.test(version.out.trim()) && version.err === '',
    version.out.trim() || `exit ${version.code}`
  )

  // Regression: --help used to go to stderr and exit 1, so it could not be piped
  // and broke `better-md --help && …`.
  const helpRun = await capture(['--help'])
  check(
    '--help goes to stdout and exits 0',
    helpRun.code === 0 && helpRun.out.includes('Usage:') && helpRun.err === '',
    `exit ${helpRun.code}`
  )

  // --- it can remove itself, alias included --------------------------------
  // Against copies in a temp directory, never the artifact under test: CI uploads
  // that file afterwards, and a smoke check that deletes its own subject would
  // break the job it belongs to.
  const rmDir = await fs.mkdtemp(path.join(os.tmpdir(), 'btr-uninstall-'))
  await fs.copyFile(binary, path.join(rmDir, 'better-md'))
  await fs.copyFile(binary, path.join(rmDir, 'btr-md'))
  await fs.writeFile(path.join(rmDir, 'unrelated'), 'not ours', 'utf8')
  await fs.chmod(path.join(rmDir, 'better-md'), 0o755)
  await fs.chmod(path.join(rmDir, 'btr-md'), 0o755)

  const removal = await new Promise((resolve) => {
    const c = spawn(path.join(rmDir, 'better-md'), ['uninstall'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (err += d))
    c.on('exit', (code) => resolve({ out, err, code }))
  })
  const leftBehind = (await fs.readdir(rmDir)).sort()

  // Two real outcomes, chosen by what the target actually is rather than by a
  // guess. A packaged binary must remove itself and its alias; anything that is
  // not one — the dev shim that runs dist-cli through node, say — must refuse and
  // leave every file alone. Both are assertions; neither is a skip that passes
  // without testing anything.
  if (removal.err.includes('not an installed build')) {
    check(
      'uninstall refuses on a non-packaged build, touching nothing',
      removal.code === 1 && leftBehind.join(',') === 'better-md,btr-md,unrelated',
      'dev shim, not a packaged binary'
    )
  } else {
    check(
      'uninstall removes the binary and its alias, keeping unrelated files',
      removal.code === 0 && leftBehind.join(',') === 'unrelated',
      `left: ${leftBehind.join(', ') || 'nothing'}`
    )
  }
  await fs.rm(rmDir, { recursive: true, force: true })

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

  // --- port selection, on the packaged binary ------------------------------
  // Hold 8080 so the preferred port is unavailable. If something else already has
  // it, that is equally fine — either way the binary must fall back rather than
  // fail, which is the whole point of the default being best-effort.
  const blocker = net.createServer()
  await new Promise((resolve) => {
    blocker.once('error', resolve) // already taken by something else: also fine
    blocker.listen(8080, '127.0.0.1', resolve)
  })
  const fellBack = await start(['--no-open', ws])
  check(
    'falls back when the preferred port is taken',
    new URL(fellBack.url).port !== '8080',
    `bound ${new URL(fellBack.url).port}`
  )
  fellBack.child.kill('SIGTERM')
  await new Promise((resolve) => blocker.close(resolve))

  // An explicit --port must be honoured exactly, never quietly moved.
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const wanted = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const pinned = await start(['--no-open', '--port', String(wanted), ws])
  check(
    'honours an explicit --port',
    new URL(pinned.url).port === String(wanted),
    `asked ${wanted}, got ${new URL(pinned.url).port}`
  )
  pinned.child.kill('SIGTERM')

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
