import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  readSession,
  removeSession,
  removeSessionSync,
  sessionDir,
  sessionFile,
  sessionIsLive,
  writeSession,
  type FetchLike,
  type SessionRecord,
} from './session.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

async function tmpHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-session-'))
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
  return home
}

const record: SessionRecord = {
  url: 'http://127.0.0.1:8080/?t=abc',
  port: 8080,
  token: 'abc',
  root: '/plans',
  pid: 1234,
}

describe('sessionFile', () => {
  it('gives each workspace root its own file', () => {
    // Per-root, so two detached servers never race on one write.
    expect(sessionFile('/home/x', '/a')).not.toBe(sessionFile('/home/x', '/b'))
    expect(sessionFile('/home/x', '/a')).toBe(sessionFile('/home/x', '/a'))
  })

  it('lives under a single directory that uninstall can remove', () => {
    expect(sessionFile('/home/x', '/a').startsWith(sessionDir('/home/x'))).toBe(true)
  })
})

describe('read/write/remove', () => {
  it('round-trips a record, creating the directory', async () => {
    const home = await tmpHome()
    const file = sessionFile(home, '/plans')

    await writeSession(file, record)

    expect(await readSession(file)).toEqual(record)
  })

  it('reports no session rather than throwing when the file is absent', async () => {
    const home = await tmpHome()
    expect(await readSession(sessionFile(home, '/plans'))).toBeNull()
  })

  it('treats a corrupt or half-written record as no session', async () => {
    const home = await tmpHome()
    const file = sessionFile(home, '/plans')
    await fs.mkdir(path.dirname(file), { recursive: true })

    for (const junk of ['not json', '{}', '{"url":"x"}', '{"port":"8080"}']) {
      await fs.writeFile(file, junk, 'utf8')
      // Reusing a partial record would send the browser to a bad URL, or worse
      // suppress starting a server that is genuinely needed.
      expect(await readSession(file), junk).toBeNull()
    }
  })

  it('removing a session that is not there is not an error', async () => {
    const home = await tmpHome()
    await expect(removeSession(sessionFile(home, '/plans'))).resolves.toBeUndefined()
  })
})

describe('sessionIsLive', () => {
  it('gives up rather than hanging on a server that never answers', async () => {
    // Node's fetch has no default timeout. A process holding the port open but
    // not replying would hang `sessions` and `--detach`'s reuse check forever.
    const hangs: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const started = Date.now()
    expect(await sessionIsLive(record, hangs, 60)).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('passes a signal so the socket is torn down, not just abandoned', async () => {
    let signal: AbortSignal | undefined
    const capture: FetchLike = (_url, init) => {
      signal = init?.signal ?? undefined
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    await sessionIsLive(record, capture)
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('is live when the recorded token still authenticates', async () => {
    const fetchImpl: FetchLike = (url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization
      expect(url).toBe('http://127.0.0.1:8080/api/workspace')
      return Promise.resolve(new Response('{}', { status: auth === 'Bearer abc' ? 200 : 401 }))
    }
    expect(await sessionIsLive(record, fetchImpl)).toBe(true)
  })

  it('is dead when something else now owns the port', async () => {
    // A pid check would pass here; only an authenticated request proves the
    // listener is ours. Ports get recycled.
    const fetchImpl: FetchLike = () => Promise.resolve(new Response('nope', { status: 401 }))
    expect(await sessionIsLive(record, fetchImpl)).toBe(false)
  })

  it('is dead when nothing is listening', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error('ECONNREFUSED'))
    expect(await sessionIsLive(record, fetchImpl)).toBe(false)
  })
})

describe('removeSessionSync', () => {
  it('deletes the record inline, which the shutdown path depends on', async () => {
    const home = await tmpHome()
    const file = sessionFile(home, '/plans')
    await writeSession(file, record)

    removeSessionSync(file)

    // Asserted immediately, with no await: the async version left every stopped
    // server's record behind because process.exit beat the unlink.
    expect(existsSync(file)).toBe(false)
  })

  it('is silent when there is nothing to remove', () => {
    expect(() => removeSessionSync('/no/such/file.json')).not.toThrow()
  })
})

describe('the state directory is disclosed', () => {
  const root = path.resolve(import.meta.dirname, '..')

  // This is the only thing better-md writes outside a workspace, so a page
  // claiming it keeps nothing is wrong rather than merely dated — the website
  // said exactly that for two commits after --detach shipped. Tied to the code
  // so the claim cannot drift away from the behaviour again.
  it.each(['README.md', 'public/site/index.html'])('%s mentions it', async (file) => {
    const text = await fs.readFile(path.join(root, file), 'utf8')
    // `~/.better-md`, not `.better-md`: the bare form is satisfied by the
    // canonical URL www.better-md.dev, so the first version of this check passed
    // whether or not the directory was disclosed at all.
    // The parent, which is what uninstall removes and what the docs name.
    // Asserting the bare string `.better-md` would be satisfied by the canonical
    // URL www.better-md.dev — the first version of this check passed whether or
    // not the directory was disclosed at all.
    const disclosed = path.dirname(sessionDir('~'))
    expect(text, `${file} does not disclose ${disclosed}`).toContain(disclosed)
  })
})
