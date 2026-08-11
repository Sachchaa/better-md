import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { describeSessions, listSessions } from './sessions.js'
import { sessionFile, type SessionRecord } from './session.js'

const dirs: string[] = []

async function tmpHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-sessions-'))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
})

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  url: 'http://127.0.0.1:8080/?t=secrettoken',
  port: 8080,
  token: 'secrettoken',
  root: '/plans/alpha',
  pid: 4242,
  ...over,
})

/** Write a record where the CLI would find it. */
async function seed(home: string, rec: SessionRecord): Promise<string> {
  const file = sessionFile(home, rec.root)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(rec), 'utf8')
  return file
}

const alwaysLive = () => Promise.resolve(true)
const neverLive = () => Promise.resolve(false)

describe('listSessions', () => {
  it('is empty when nothing has ever run detached', async () => {
    // The directory does not exist until a detached run creates it, and that is
    // not an error worth reporting.
    expect(await listSessions({ home: await tmpHome(), isLive: alwaysLive })).toEqual([])
  })

  it('reports a live session with its root and address', async () => {
    const home = await tmpHome()
    await seed(home, record())
    const [session] = await listSessions({ home, isLive: alwaysLive })
    expect(session).toMatchObject({ root: '/plans/alpha', port: 8080, pid: 4242, live: true })
  })

  it('lists one entry per workspace', async () => {
    const home = await tmpHome()
    await seed(home, record({ root: '/plans/alpha' }))
    await seed(home, record({ root: '/plans/beta', port: 8081 }))
    const found = await listSessions({ home, isLive: alwaysLive })
    expect(found.map((s) => s.root).sort()).toEqual(['/plans/alpha', '/plans/beta'])
  })

  it('sorts by root, so repeated runs list in the same order', async () => {
    // Records are named by a hash of the root, so readdir order has nothing to do
    // with root order. The second assertion is what keeps this test honest: with
    // only two roots the disk order once matched the sorted order by luck, and the
    // test passed with no sort at all.
    const home = await tmpHome()
    const roots = ['/plans/zeta', '/plans/mu', '/plans/alpha', '/plans/kappa', '/plans/beta']
    for (const [i, root] of roots.entries()) {
      await seed(home, record({ root, port: 8080 + i }))
    }

    const listed = (await listSessions({ home, isLive: alwaysLive })).map((s) => s.root)
    expect(listed).toEqual([...roots].sort())

    const onDisk = await fs.readdir(path.dirname(sessionFile(home, roots[0])))
    const diskOrder = await Promise.all(
      onDisk.map(async (n) =>
        JSON.parse(
          await fs.readFile(path.join(path.dirname(sessionFile(home, roots[0])), n), 'utf8')
        ).root
      )
    )
    expect(diskOrder).not.toEqual(listed)
  })

  it('prunes a record whose server is gone', async () => {
    // A SIGKILL or a reboot leaves the record behind. Listing it as though it
    // were usable is worse than not listing it at all.
    const home = await tmpHome()
    const file = await seed(home, record())
    expect(await listSessions({ home, isLive: neverLive })).toEqual([])
    await expect(fs.access(file)).rejects.toThrow()
  })

  it('keeps a live record on disk', async () => {
    const home = await tmpHome()
    const file = await seed(home, record())
    await listSessions({ home, isLive: alwaysLive })
    await expect(fs.access(file)).resolves.toBeUndefined()
  })

  it('prunes a malformed record rather than reporting it', async () => {
    const home = await tmpHome()
    const dir = path.dirname(sessionFile(home, '/x'))
    await fs.mkdir(dir, { recursive: true })
    const junk = path.join(dir, 'broken.json')
    await fs.writeFile(junk, '{ not json', 'utf8')
    expect(await listSessions({ home, isLive: alwaysLive })).toEqual([])
    await expect(fs.access(junk)).rejects.toThrow()
  })

  it('ignores files that are not session records', async () => {
    // Something else's file in there must not be deleted.
    const home = await tmpHome()
    const dir = path.dirname(sessionFile(home, '/x'))
    await fs.mkdir(dir, { recursive: true })
    const stray = path.join(dir, 'notes.txt')
    await fs.writeFile(stray, 'hello', 'utf8')
    expect(await listSessions({ home, isLive: alwaysLive })).toEqual([])
    await expect(fs.access(stray)).resolves.toBeUndefined()
  })

  it('checks liveness by asking the server, not by trusting the pid', async () => {
    // Ports and pids both get recycled, so a pid that happens to exist proves
    // nothing about whether it is still our server.
    const home = await tmpHome()
    await seed(home, record({ pid: process.pid }))
    expect(await listSessions({ home, isLive: neverLive })).toEqual([])
  })

  it('checks the sessions concurrently, so one hung server does not stall the rest', async () => {
    const home = await tmpHome()
    for (let i = 0; i < 4; i++) {
      await seed(home, record({ root: `/plans/${i}`, port: 8080 + i }))
    }
    let running = 0
    let peak = 0
    const isLive = async (): Promise<boolean> => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 10))
      running -= 1
      return true
    }
    await listSessions({ home, isLive })
    expect(peak).toBeGreaterThan(1)
  })
})

describe('describeSessions', () => {
  const live = {
    root: '/plans/alpha',
    url: 'http://127.0.0.1:8080/?t=secrettoken',
    port: 8080,
    pid: 4242,
    live: true,
  }

  it('names the workspace and the address', () => {
    const text = describeSessions([live], 'better-md')
    expect(text).toContain('/plans/alpha')
    expect(text).toContain('127.0.0.1:8080')
  })

  it('never prints the token', () => {
    // The record holds the bearer token for that server. A listing someone will
    // paste into an issue must not carry it.
    const text = describeSessions([live], 'better-md')
    expect(text).not.toContain('secrettoken')
    expect(text).not.toContain('?t=')
  })

  it('says plainly when there is nothing, and why there might not be', () => {
    const text = describeSessions([], 'better-md')
    expect(text).toContain('No sessions')
    // The likeliest reason for an empty list is that nothing ran with --detach.
    expect(text).toContain('--detach')
  })

  it('counts what it found', () => {
    const two = describeSessions([live, { ...live, root: '/plans/beta', port: 8081 }], 'better-md')
    expect(two).toMatch(/2 sessions/)
    expect(describeSessions([live], 'better-md')).toMatch(/1 session\b/)
  })

  it('uses the name the CLI was invoked as', () => {
    expect(describeSessions([], 'btr-md')).toContain('btr-md')
    expect(describeSessions([], 'btr-md')).not.toContain('better-md')
  })
})
