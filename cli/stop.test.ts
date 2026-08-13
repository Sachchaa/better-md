import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { sessionFile, type SessionRecord } from './session.js'
import { describeStopped, stopSessions } from './stop.js'

const dirs: string[] = []

async function tmpHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-stop-'))
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

async function seed(home: string, rec: SessionRecord): Promise<string> {
  const file = sessionFile(home, rec.root)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(rec), 'utf8')
  return file
}

/** A world where every recorded server is ours and dies when signalled. */
function world() {
  const signalled: Array<{ pid: number; sig: string }> = []
  const dead = new Set<number>()
  return {
    signalled,
    dead,
    isLive: () => Promise.resolve(true),
    signal: (pid: number, sig: string) => {
      signalled.push({ pid, sig })
      dead.add(pid)
    },
    isRunning: (pid: number) => !dead.has(pid),
  }
}

describe('stopSessions', () => {
  it('stops every session when no workspace is named', async () => {
    const home = await tmpHome()
    await seed(home, record({ root: '/plans/alpha', pid: 11 }))
    await seed(home, record({ root: '/plans/beta', pid: 22, port: 8081 }))
    const w = world()
    const results = await stopSessions({ home, root: null, ...w })
    expect(results.map((r) => r.outcome)).toEqual(['stopped', 'stopped'])
    expect(w.signalled.map((s) => s.pid).sort()).toEqual([11, 22])
  })

  it('stops only the workspace named, leaving the others alone', async () => {
    const home = await tmpHome()
    await seed(home, record({ root: '/plans/alpha', pid: 11 }))
    await seed(home, record({ root: '/plans/beta', pid: 22, port: 8081 }))
    const w = world()
    const results = await stopSessions({ home, root: '/plans/beta', ...w })
    expect(results).toEqual([
      { root: '/plans/beta', port: 8081, pid: 22, outcome: 'stopped' },
    ])
    expect(w.signalled).toEqual([{ pid: 22, sig: 'SIGTERM' }])
  })

  it('asks for a graceful shutdown, never SIGKILL', async () => {
    // SIGTERM runs the server's shutdown handler, which closes the port and
    // removes its own record. SIGKILL skips both.
    const home = await tmpHome()
    await seed(home, record({ pid: 11 }))
    const w = world()
    await stopSessions({ home, root: null, ...w })
    expect(w.signalled).toEqual([{ pid: 11, sig: 'SIGTERM' }])
  })

  it('never signals a pid it has not confirmed is our server', async () => {
    // The whole reason this is a command rather than `kill $(…)`: between listing
    // and signalling, a server can exit and its pid be handed to something else.
    // A record that does not answer is not ours, so nothing gets signalled.
    const home = await tmpHome()
    const file = await seed(home, record({ pid: 11 }))
    const w = { ...world(), isLive: () => Promise.resolve(false) }
    const results = await stopSessions({ home, root: null, ...w })
    expect(w.signalled).toEqual([])
    expect(results).toEqual([])
    // And the record it could not confirm is cleaned up rather than left to
    // mislead the next listing.
    await expect(fs.access(file)).rejects.toThrow()
  })

  it('waits for the process to actually go', async () => {
    const home = await tmpHome()
    await seed(home, record({ pid: 11 }))
    let checks = 0
    const dead = new Set<number>()
    const results = await stopSessions({
      home,
      root: null,
      isLive: () => Promise.resolve(true),
      signal: () => {},
      isRunning: () => {
        checks += 1
        // Lingers for a moment, as a real process does between signal and exit.
        if (checks > 2) dead.add(11)
        return !dead.has(11)
      },
      waitMs: 500,
    })
    expect(results[0].outcome).toBe('stopped')
    expect(checks).toBeGreaterThan(1)
  })

  it('reports a server that ignored the signal instead of escalating', async () => {
    // Escalating to SIGKILL is a decision for the person at the keyboard, not a
    // silent fallback: it skips the shutdown handler and can leave a half-written
    // file behind.
    const home = await tmpHome()
    await seed(home, record({ pid: 11 }))
    const results = await stopSessions({
      home,
      root: null,
      isLive: () => Promise.resolve(true),
      signal: () => {},
      isRunning: () => true,
      waitMs: 50,
    })
    expect(results).toEqual([{ root: '/plans/alpha', port: 8080, pid: 11, outcome: 'refused' }])
  })

  it('removes the record even when the server did not', async () => {
    const home = await tmpHome()
    const file = await seed(home, record({ pid: 11 }))
    await stopSessions({ home, root: null, ...world() })
    await expect(fs.access(file)).rejects.toThrow()
  })

  it('is empty when nothing is running', async () => {
    expect(await stopSessions({ home: await tmpHome(), root: null, ...world() })).toEqual([])
  })

  it('is empty when the named workspace has no session', async () => {
    const home = await tmpHome()
    await seed(home, record({ root: '/plans/alpha', pid: 11 }))
    const w = world()
    expect(await stopSessions({ home, root: '/plans/nothing', ...w })).toEqual([])
    expect(w.signalled).toEqual([])
  })

  it('does not signal a live session in another workspace', async () => {
    const home = await tmpHome()
    await seed(home, record({ root: '/plans/alpha', pid: 11 }))
    await seed(home, record({ root: '/plans/beta', pid: 22, port: 8081 }))
    const w = world()
    await stopSessions({ home, root: '/plans/alpha', ...w })
    expect(w.signalled.map((s) => s.pid)).toEqual([11])
    // Beta's record survives, because beta is still running.
    await expect(fs.access(sessionFile(home, '/plans/beta'))).resolves.toBeUndefined()
  })
})

describe('describeStopped', () => {
  const stopped = { root: '/plans/alpha', port: 8080, pid: 11, outcome: 'stopped' as const }

  it('names what it stopped', () => {
    const text = describeStopped([stopped], 'better-md')
    expect(text).toContain('/plans/alpha')
    expect(text).toMatch(/1 session\b/)
  })

  it('counts more than one', () => {
    const text = describeStopped([stopped, { ...stopped, root: '/plans/beta', pid: 22 }], 'better-md')
    expect(text).toMatch(/2 sessions/)
  })

  it('says so when there was nothing to stop', () => {
    expect(describeStopped([], 'better-md')).toContain('No sessions')
  })

  it('says what to do about a server that refused', () => {
    // A dead end here is useless: the reader needs the pid and the next step.
    const text = describeStopped([{ ...stopped, outcome: 'refused' }], 'better-md')
    expect(text).toContain('11')
    expect(text).toContain('kill -9')
  })

  it('never prints a token', () => {
    expect(describeStopped([stopped], 'better-md')).not.toContain('secrettoken')
  })
})
