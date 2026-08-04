import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startServer, type ServerHandle } from './server.js'
import { Workspace } from './workspace.js'

// The cli test project has no DOM lib, so @types/node's fetch typings give
// `Response#json()` a return type of `unknown` (deliberately, unlike DOM
// lib's `any`) rather than the previously-assumed `Promise<any>`. Narrowing
// with these shapes keeps the test file type-clean under `tsc -b` without
// weakening any assertion below.
interface DocReadBody {
  relPath: string
  content: string
  mtimeMs: number
}

interface ConflictBody {
  error: string
  theirContent: string | null
  theirMtimeMs: number | null
}

const cleanups: Array<() => Promise<void>> = []

async function harness(): Promise<{ handle: ServerHandle; root: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-server-'))
  const root = path.join(base, 'root')
  const dist = path.join(base, 'dist')
  await fs.mkdir(root)
  await fs.mkdir(path.join(dist, 'assets'), { recursive: true })
  await fs.writeFile(path.join(root, 'notes.md'), '# notes', 'utf8')
  await fs.writeFile(path.join(dist, 'index.html'), '<div id="root"></div>', 'utf8')
  await fs.writeFile(path.join(dist, 'assets', 'app.js'), 'console.log(1)', 'utf8')

  const workspace = new Workspace({
    root: await fs.realpath(root),
    files: [{ name: 'notes.md', relPath: 'notes.md' }],
    active: 'notes.md',
  })
  const handle = await startServer({ workspace, distDir: dist })
  cleanups.push(async () => {
    await handle.close()
    await fs.rm(base, { recursive: true, force: true })
  })
  return { handle, root }
}

function auth(handle: ServerHandle): Record<string, string> {
  return { authorization: `Bearer ${handle.token}` }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

describe('static serving', () => {
  it('serves index.html at the root', async () => {
    const { handle } = await harness()
    const res = await fetch(handle.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('id="root"')
  })

  it('serves assets', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/assets/app.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
  })

  it('refuses traversal out of the dist directory', async () => {
    const { handle } = await harness()
    // A plain `%2e%2e` traversal (as one might first reach for) never reaches
    // this check at all: the WHATWG URL Standard that both fetch() and this
    // server's own `new URL(req.url, ...)` parse the target through collapses
    // `%2e%2e` dot-segments the moment the URL is constructed — verified via
    // `new URL('http://h/assets/%2e%2e/%2e%2e/root/notes.md').pathname` already
    // being `/root/notes.md` before any of our code runs. Encoding the slash
    // instead (`%2f`) survives that parse — the WHATWG normaliser only
    // collapses a segment that IS literally ".." between real `/` delimiters,
    // and `..%2f..%2f` reads as one opaque segment to it — so this reaches
    // serveStatic still encoded, where a single decodeURIComponent pass (not
    // the double-decode a real exploit would need to fool a naive filter)
    // turns it into a genuine `../../` that resolves outside `distDir`, right
    // onto the workspace's own notes.md.
    const res = await fetch(`${handle.origin}/assets/..%2f..%2froot/notes.md`)
    expect(res.status).toBe(400)
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
    const body = (await res.json()) as DocReadBody
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
    const read = (await (
      await fetch(`${handle.origin}/api/doc?path=notes.md`, { headers: auth(handle) })
    ).json()) as DocReadBody

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
    const body = (await res.json()) as ConflictBody
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

describe('events', () => {
  it('streams a notified change over SSE', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/events`, { headers: auth(handle) })
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    handle.notify({ type: 'changed', relPath: 'notes.md' })

    // The server writes the connection comment and the notified frame as two
    // separate `res.write()` calls, each its own HTTP chunked-encoding frame;
    // the client's ReadableStream delivers them as two separate reads in that
    // order regardless of how close together they were written. A single
    // `reader.read()` deterministically returns only the first (the comment),
    // so accumulate reads until the notified frame shows up.
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let received = ''
    while (!received.includes('"relPath":"notes.md"')) {
      const { value, done } = await reader.read()
      if (done) throw new Error('SSE stream ended before the notified event arrived')
      received += decoder.decode(value)
    }
    expect(received).toContain('"relPath":"notes.md"')
    await reader.cancel()
  })
})

// Carried forward from Task 3's review: Workspace.write() lets a raw fs errno
// (e.g. EACCES writing a mode-444 document) escape uncaught. The HTTP layer is
// the catch-all for that class, and its 500 response must not hand the client
// the absolute on-disk path that a raw Node errno message contains.
describe('error handling', () => {
  it('answers an unexpected filesystem error with 500 and no leaked path', async () => {
    const { handle, root } = await harness()
    const target = path.join(root, 'notes.md')
    // Use the file's actual mtime, not Date.now(): the conflict check only
    // tolerates a 1ms drift, so a wall-clock timestamp taken here would race
    // against the real mtime and intermittently trip a 409 before the write
    // — and thus the EACCES this test exists to exercise — is ever attempted.
    const { mtimeMs } = await fs.stat(target)
    await fs.chmod(target, 0o444)
    cleanups.push(async () => {
      await fs.chmod(target, 0o644).catch(() => {})
    })

    const res = await fetch(`${handle.origin}/api/doc`, {
      method: 'PUT',
      headers: { ...auth(handle), 'content-type': 'application/json' },
      body: JSON.stringify({ relPath: 'notes.md', content: 'nope', baseMtimeMs: mtimeMs }),
    })

    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain(root)
    expect(text).not.toContain(os.tmpdir())
  })
})
