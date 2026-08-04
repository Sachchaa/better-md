import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { ASSETS, type EmbeddedAsset } from './assets.generated.js'
import { startServer, type ServerHandle } from './server.js'
import { Workspace } from './workspace.js'

const cleanups: Array<() => Promise<void>> = []

/**
 * A stand-in for the embedded editor bundle.
 *
 * Deliberately NOT the real `ASSETS`: that map is generated from `dist/`, so
 * using it made these tests assert against whatever the working directory
 * happened to contain — a real, empty placeholder manifest on a fresh clone or
 * in CI, where `pnpm test` runs before `pnpm build`. The static route's job is
 * "serve what is in the map, 404 otherwise", and this proves that without a web
 * build in the loop. The packaged binary's real assets are covered end-to-end by
 * scripts/smoke-binary.mjs.
 */
const FIXTURE_ASSETS: ReadonlyMap<string, EmbeddedAsset> = new Map([
  [
    'index.html',
    {
      contentType: 'text/html; charset=utf-8',
      base64: Buffer.from(
        '<!doctype html><div id="root"></div><script src="/assets/index-fixture.js"></script>',
        'utf8'
      ).toString('base64'),
    },
  ],
  [
    'assets/index-fixture.js',
    {
      contentType: 'text/javascript; charset=utf-8',
      base64: Buffer.from('console.log("fixture bundle")', 'utf8').toString('base64'),
    },
  ],
])

interface Harness {
  handle: ServerHandle
  root: string
  /** Everything the server logged during this test. */
  logs: string[]
}

/**
 * @param injectAssets pass false to let the server fall back to its embedded
 * bundle, which is what the fallback test needs and nothing else should use.
 */
async function harness({ injectAssets = true } = {}): Promise<Harness> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-server-'))
  const root = path.join(base, 'root')
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, 'notes.md'), '# notes', 'utf8')

  const workspace = new Workspace({
    root: await fs.realpath(root),
    files: [{ name: 'notes.md', relPath: 'notes.md' }],
    active: 'notes.md',
  })
  // Capture the log instead of writing to stderr: it keeps the suite's output
  // pristine AND makes "what did the operator see" assertable.
  const logs: string[] = []
  const handle = await startServer({
    workspace,
    log: (message) => logs.push(message),
    ...(injectAssets ? { assets: FIXTURE_ASSETS } : {}),
  })
  cleanups.push(async () => {
    await handle.close()
    await fs.rm(base, { recursive: true, force: true })
  })
  return { handle, root, logs }
}

function auth(handle: ServerHandle): Record<string, string> {
  return { authorization: `Bearer ${handle.token}` }
}

/**
 * `Response.json()` is `Promise<unknown>` under @types/node (no DOM lib), so a
 * cast is required for property access under `strict`. Narrow, local shapes keep
 * that honest rather than reaching for `any`.
 */
interface DocBody {
  relPath: string
  content: string
  mtimeMs: number
}
interface ConflictBody {
  error: string
  theirContent: string | null
  theirMtimeMs: number | null
}
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

describe('static serving', () => {
  it('serves the embedded index.html at the root', async () => {
    const { handle } = await harness()
    const res = await fetch(handle.url)

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('id="root"')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('serves an embedded script with its recorded content type', async () => {
    const { handle } = await harness()
    // Derived from the manifest rather than hardcoded, so this keeps asserting
    // "whatever .js the map holds is served with a JS content type" rather than
    // one fixed filename.
    const key = [...FIXTURE_ASSETS.keys()].find((k) => k.endsWith('.js'))
    expect(key).toBeDefined()

    const res = await fetch(`${handle.origin}/${key!}`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  // These used to be traversal and symlink-escape guards over a real dist/
  // directory. Assets are now embedded at build time and the static route makes
  // no filesystem call at all, so the escape is unreachable by construction
  // rather than defended against. What is worth asserting is exactly that: an
  // off-manifest key is a miss, not a lookup.
  it.each([
    ['percent-encoded separators', '/assets/..%2f..%2froot/notes.md'],
    ['dot segments', '/assets/../../root/notes.md'],
    ['an absolute-looking path', '//etc/passwd'],
    ['a workspace document by name', '/notes.md'],
  ])('does not serve %s', async (_label, target) => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}${target}`)

    // 404, not 400: there is nothing to reject, the key simply is not embedded.
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('# notes')
  })

  it('falls back to the embedded bundle when no assets are injected', async () => {
    // Guards the `options.assets ?? ASSETS` default. Every test above injects a
    // fixture, so a typo in that default — an empty map, the wrong symbol — would
    // leave the real CLI serving nothing with the whole suite still green.
    // Asserts the wiring against whatever the manifest holds rather than against
    // specific contents, so it works both on a fresh clone (placeholder manifest)
    // and after a build. CI builds before testing, which is what makes the
    // populated branch the one actually exercised there.
    const { handle } = await harness({ injectAssets: false })

    const res = await fetch(`${handle.origin}/`)
    await res.text()
    expect(res.status).toBe(ASSETS.has('index.html') ? 200 : 404)
  })

  it('refuses a malformed percent-escape without logging', async () => {
    const { handle, logs } = await harness()
    const res = await fetch(`${handle.origin}/%zz`)
    expect(res.status).toBe(400)
    // This route has no auth gate, so a page could otherwise flood the terminal.
    expect(logs).toEqual([])
  })
})

describe('API authentication', () => {
  it('rejects a missing token with 401', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/workspace`)
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token with 401', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/workspace`, {
      headers: { authorization: 'Bearer not-the-token' },
    })
    expect(res.status).toBe(401)
  })

  // 'not-the-token' above differs in LENGTH from the real 64-char hex token, so it
  // short-circuits at timingSafeEqualStr's length check and never reaches
  // crypto.timingSafeEqual. Reversing the real token keeps the length identical
  // (only the value differs), so this is the only case in the suite that actually
  // exercises the timing-safe comparison itself.
  it('rejects a same-length wrong token with 401', async () => {
    const { handle } = await harness()
    const wrongToken = [...handle.token].reverse().join('')
    const res = await fetch(`${handle.origin}/api/workspace`, {
      headers: { authorization: `Bearer ${wrongToken}` },
    })
    expect(res.status).toBe(401)
  })

  it('rejects a foreign Origin with 403', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/workspace`, {
      headers: { ...auth(handle), origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('accepts its own Origin', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/workspace`, {
      headers: { ...auth(handle), origin: handle.origin },
    })
    expect(res.status).toBe(200)
  })
})

describe('document API', () => {
  it('lists the workspace', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/workspace`, { headers: auth(handle) })
    expect(await res.json()).toEqual({
      files: [{ name: 'notes.md', relPath: 'notes.md' }],
      active: 'notes.md',
    })
  })

  it('reads a document', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/doc?path=notes.md`, { headers: auth(handle) })
    const body = await json<DocBody>(res)
    expect(body.content).toBe('# notes')
    expect(body.mtimeMs).toBeGreaterThan(0)
  })

  it('rejects a traversal path with 400', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/doc?path=${encodeURIComponent('../secret.md')}`, {
      headers: auth(handle),
    })
    expect(res.status).toBe(400)
  })

  it('saves a document and reports the new mtime', async () => {
    const { handle, root } = await harness()
    const read = await json<DocBody>(
      await fetch(`${handle.origin}/api/doc?path=notes.md`, { headers: auth(handle) })
    )

    const res = await fetch(`${handle.origin}/api/doc`, {
      method: 'PUT',
      headers: { ...auth(handle), 'content-type': 'application/json' },
      body: JSON.stringify({ relPath: 'notes.md', content: 'saved!', baseMtimeMs: read.mtimeMs }),
    })

    expect(res.status).toBe(200)
    expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe('saved!')
  })

  it('returns 409 with their content when the base mtime is stale', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/doc`, {
      method: 'PUT',
      headers: { ...auth(handle), 'content-type': 'application/json' },
      body: JSON.stringify({ relPath: 'notes.md', content: 'mine', baseMtimeMs: 1 }),
    })

    expect(res.status).toBe(409)
    const body = await json<ConflictBody>(res)
    expect(body.theirContent).toBe('# notes')
    expect(body.theirMtimeMs).toBeGreaterThan(0)
  })

  it('returns 404 for a document that does not exist', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/doc?path=ghost.md`, { headers: auth(handle) })
    expect(res.status).toBe(404)
  })

  // A non-numeric baseMtimeMs must not be coerced. Number('nonsense') is NaN, and
  // NaN compares false against every conflict check, so coercion here would let a
  // request overwrite a document without knowing its mtime.
  it.each([
    ['a string', 'nonsense'],
    ['a boolean', true],
    ['an object', {}],
  ])('rejects %s baseMtimeMs with 400 and leaves the file alone', async (_label, value) => {
    const { handle, root } = await harness()
    const res = await fetch(`${handle.origin}/api/doc`, {
      method: 'PUT',
      headers: { ...auth(handle), 'content-type': 'application/json' },
      body: JSON.stringify({ relPath: 'notes.md', content: 'CLOBBERED', baseMtimeMs: value }),
    })

    expect(res.status).toBe(400)
    expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe('# notes')
  })
})

describe('shutdown', () => {
  // Regression guard: server.close() alone waits on lingering connections, so a
  // half-sent request or an aborted SSE stream left it pending for seconds. The
  // CLI wires SIGINT to close(), so that reads to a user as Ctrl-C hanging.
  it('closes promptly with a half-sent request in flight', async () => {
    const { handle } = await harness()

    // Headers sent, body promised but never delivered — the connection lingers.
    const socket = net.connect(handle.port, '127.0.0.1')
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()))
    socket.write('PUT /api/doc HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 999\r\n\r\n{')

    const started = performance.now()
    await handle.close()
    const elapsed = performance.now() - started

    // Generous bound: the failure mode was seconds, not milliseconds.
    expect(elapsed).toBeLessThan(1000)
    socket.destroy()
  })
})

describe('malformed request targets', () => {
  /**
   * `fetch` cannot send an unparseable target — its own URL parser rejects it
   * first — so this needs a raw socket. Worth the awkwardness: before the guard,
   * `new URL(req.url)` threw synchronously inside the http listener, which
   * `done.catch` never sees, so the CLI died with an uncaughtException. Nothing
   * in the fetch-based suite could reach that.
   */
  function rawRequest(port: number, target: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
      })
      let data = ''
      socket.setTimeout(5000, () => {
        socket.destroy()
        reject(new Error(`no response for ${target}`))
      })
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8')
      })
      socket.on('end', () => resolve(data))
      socket.on('error', reject)
    })
  }

  it.each([
    ['bracketed host', '//[::1'],
    ['bare scheme', 'https://['],
  ])('answers 400 for a %s target and keeps serving', async (_label, target) => {
    const { handle } = await harness()

    expect(await rawRequest(handle.port, target)).toContain('400')

    // The real regression: the process must still be alive and serving.
    const after = await fetch(`${handle.origin}/`)
    expect(after.status).toBe(200)
  })
})

describe('error handling', () => {
  // A read-only file must reach the client as an actionable, relPath-only
  // message — not a generic 500, and never carrying the absolute path.
  it('maps a permission-denied write to a 403 naming relPath, not the absolute path', async () => {
    const { handle, root, logs } = await harness()
    const target = path.join(root, 'notes.md')
    const mtimeMs = (await fs.stat(target)).mtimeMs
    await fs.chmod(target, 0o444)
    // Registered, not trailing: a failed assertion below must not skip the restore.
    cleanups.push(() => fs.chmod(target, 0o644))

    const res = await fetch(`${handle.origin}/api/doc`, {
      method: 'PUT',
      headers: { ...auth(handle), 'content-type': 'application/json' },
      body: JSON.stringify({ relPath: 'notes.md', content: 'nope', baseMtimeMs: mtimeMs }),
    })

    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('notes.md')
    expect(body.error).not.toContain(root)
    expect(body.error).not.toContain(os.tmpdir())

    // The operator DOES get the full detail, including the real path — that
    // asymmetry is the point, and it is the only assertion that proves the
    // detail was not simply discarded.
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('EACCES')
    expect(logs[0]).toContain(target)
  })
})

describe('events', () => {
  it('streams a notified change over SSE', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/events`, { headers: auth(handle) })
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    handle.notify({ type: 'changed', relPath: 'notes.md' })

    // The preamble and the event are separate chunked frames, so a single read()
    // deterministically sees only ': connected'. Accumulate until the event shows
    // up, with a `done` guard so a regression fails instead of hanging.
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    while (!seen.includes('"relPath":"notes.md"')) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }
    await reader.cancel()

    expect(seen).toContain('"relPath":"notes.md"')
    expect(seen).toContain('"type":"changed"')
  })
})
