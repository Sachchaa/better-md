import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  checkForUpdate,
  describeCheck,
  findChecksum,
  latestVersion,
  selfUpdate,
  UpdateError,
  type FetchLike,
} from './update.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

/** A fetch that answers from a map of url -> [status, body]. */
function fakeFetch(routes: Record<string, [number, string | Uint8Array]>): FetchLike {
  return (url) => {
    const hit = routes[url]
    if (hit === undefined) return Promise.resolve(new Response('not found', { status: 404 }))
    const [status, body] = hit
    return Promise.resolve(new Response(body, { status }))
  }
}

const API = 'https://api.github.com/repos/Sachchaa/better-md/releases/latest'
const DL = 'https://github.com/Sachchaa/better-md/releases/latest/download'

describe('latestVersion', () => {
  it('reads the tag name', async () => {
    const fetchImpl = fakeFetch({ [API]: [200, JSON.stringify({ tag_name: 'v0.4.0' })] })
    expect(await latestVersion(fetchImpl)).toBe('v0.4.0')
  })

  it('explains a rate limit rather than reporting a bare status', async () => {
    const fetchImpl = fakeFetch({ [API]: [403, '{}'] })
    // 403 from this endpoint is nearly always the unauthenticated rate limit, and
    // "GitHub answered 403" would send someone hunting for a permissions problem.
    await expect(latestVersion(fetchImpl)).rejects.toThrow(/rate-limited/)
  })

  it('surfaces an offline failure as an UpdateError, not a raw TypeError', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'))
    await expect(latestVersion(fetchImpl)).rejects.toThrow(UpdateError)
    await expect(latestVersion(fetchImpl)).rejects.toThrow(/could not reach GitHub/)
  })

  it('rejects a response with no usable tag', async () => {
    const fetchImpl = fakeFetch({ [API]: [200, JSON.stringify({ tag_name: '' })] })
    await expect(latestVersion(fetchImpl)).rejects.toThrow(/no tag name/)
  })
})

describe('checkForUpdate / describeCheck', () => {
  it('reports an available update', async () => {
    const fetchImpl = fakeFetch({ [API]: [200, JSON.stringify({ tag_name: 'v0.4.0' })] })
    const check = await checkForUpdate('0.1.0', fetchImpl)
    expect(check).toEqual({ current: '0.1.0', latest: 'v0.4.0', newer: true })
    expect(describeCheck(check, 'better-md')).toContain('out of date')
    expect(describeCheck(check, 'better-md')).toContain('better-md update')
  })

  it('reports being current, and names the alias that was invoked', async () => {
    const fetchImpl = fakeFetch({ [API]: [200, JSON.stringify({ tag_name: 'v0.1.0' })] })
    const check = await checkForUpdate('0.1.0', fetchImpl)
    expect(check.newer).toBe(false)
    expect(describeCheck(check, 'btr-md')).toBe('btr-md 0.1.0 is up to date.')
  })
})

describe('findChecksum', () => {
  const sums = [
    `${'a'.repeat(64)}  better-md-darwin-arm64`,
    `${'b'.repeat(64)}  better-md-linux-x64`,
    `${'c'.repeat(64)} *better-md-linux-arm64`,
  ].join('\n')

  it('finds the entry for an asset', () => {
    expect(findChecksum(sums, 'better-md-linux-x64')).toBe('b'.repeat(64))
  })

  it('handles the binary-mode asterisk', () => {
    expect(findChecksum(sums, 'better-md-linux-arm64')).toBe('c'.repeat(64))
  })

  it('does not match a different asset that shares a prefix', () => {
    // The failure this prevents is verifying a download against the wrong file's
    // checksum, which would either reject a good binary or accept a bad one.
    expect(findChecksum(sums, 'better-md-linux')).toBeNull()
    expect(findChecksum(`${'d'.repeat(64)}  better-md-linux-x64-musl`, 'better-md-linux-x64')).toBe(
      null
    )
  })

  it('returns null for a missing entry', () => {
    expect(findChecksum(sums, 'better-md-darwin-x64')).toBeNull()
  })
})

describe('selfUpdate', () => {
  /** A fake install directory holding a "current" binary. */
  async function installed(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-update-'))
    const exe = path.join(dir, 'better-md')
    await fs.writeFile(exe, 'OLD BINARY', { mode: 0o755 })
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
    return exe
  }

  function release(tag: string, payload: string, checksum?: string) {
    const sum = checksum ?? createHash('sha256').update(payload).digest('hex')
    return fakeFetch({
      [API]: [200, JSON.stringify({ tag_name: tag })],
      [`${DL}/better-md-linux-x64`]: [200, payload],
      [`${DL}/SHA256SUMS`]: [200, `${sum}  better-md-linux-x64\n`],
    })
  }

  it('replaces the binary in place when a newer release exists', async () => {
    const exe = await installed()

    const result = await selfUpdate({
      currentVersion: '0.1.0',
      executable: exe,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: release('v0.2.0', 'NEW BINARY'),
      log: () => {},
    })

    expect(result).toBe('updated 0.1.0 -> v0.2.0')
    expect(await fs.readFile(exe, 'utf8')).toBe('NEW BINARY')
    // Still executable: a correctly-downloaded binary that cannot be run is a
    // broken update.
    expect((await fs.stat(exe)).mode & 0o111).toBeGreaterThan(0)
  })

  it('refuses a checksum mismatch and leaves the old binary untouched', async () => {
    const exe = await installed()

    await expect(
      selfUpdate({
        currentVersion: '0.1.0',
        executable: exe,
        platform: 'linux',
        arch: 'x64',
        fetchImpl: release('v0.2.0', 'TAMPERED', 'f'.repeat(64)),
        log: () => {},
      })
    ).rejects.toThrow(/checksum mismatch/)

    // The whole point: a failed verification must not have already overwritten
    // the working binary.
    expect(await fs.readFile(exe, 'utf8')).toBe('OLD BINARY')
    const leftovers = (await fs.readdir(path.dirname(exe))).filter((f) => f.includes('update-'))
    expect(leftovers, 'staging file was left behind').toEqual([])
  })

  it('refuses when SHA256SUMS has no entry for the asset', async () => {
    const exe = await installed()
    const fetchImpl = fakeFetch({
      [API]: [200, JSON.stringify({ tag_name: 'v0.2.0' })],
      [`${DL}/better-md-linux-x64`]: [200, 'NEW'],
      [`${DL}/SHA256SUMS`]: [200, `${'a'.repeat(64)}  some-other-asset\n`],
    })

    await expect(
      selfUpdate({
        currentVersion: '0.1.0',
        executable: exe,
        platform: 'linux',
        arch: 'x64',
        fetchImpl,
        log: () => {},
      })
    ).rejects.toThrow(/no entry for/)
    expect(await fs.readFile(exe, 'utf8')).toBe('OLD BINARY')
  })

  it('does nothing when already current', async () => {
    const exe = await installed()

    const result = await selfUpdate({
      currentVersion: '0.2.0',
      executable: exe,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: release('v0.2.0', 'NEW BINARY'),
      log: () => {},
    })

    expect(result).toContain('already on the latest version')
    expect(await fs.readFile(exe, 'utf8')).toBe('OLD BINARY')
  })

  it('refuses to self-update a checkout rather than corrupting something', async () => {
    // executable === null means `node dist-cli/index.js`: there is no packaged
    // binary to replace, and overwriting process.execPath would clobber Node.
    await expect(
      selfUpdate({
        currentVersion: '0.1.0',
        executable: null,
        platform: 'linux',
        arch: 'x64',
        fetchImpl: release('v0.2.0', 'NEW'),
        log: () => {},
      })
    ).rejects.toThrow(/not an installed build/)
  })

  it('refuses on a platform with no published build', async () => {
    const exe = await installed()
    await expect(
      selfUpdate({
        currentVersion: '0.1.0',
        executable: exe,
        platform: 'win32',
        arch: 'x64',
        fetchImpl: release('v0.2.0', 'NEW'),
        log: () => {},
      })
    ).rejects.toThrow(/no prebuilt binary for win32/)
  })
})
