import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { uninstall, UninstallError } from './uninstall.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

/** An install directory holding `better-md` plus whatever else is asked for. */
async function installDir(extra: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-uninstall-'))
  await fs.writeFile(path.join(dir, 'better-md'), 'BINARY', { mode: 0o755 })
  for (const [name, body] of Object.entries(extra)) {
    await fs.writeFile(path.join(dir, name), body, { mode: 0o755 })
  }
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

describe('uninstall', () => {
  it('removes the running binary and reports it', async () => {
    const dir = await installDir()

    const removed = await uninstall({ executable: path.join(dir, 'better-md'), log: () => {} })

    expect(removed).toEqual([path.join(dir, 'better-md')])
    await expect(fs.access(path.join(dir, 'better-md'))).rejects.toThrow()
  })

  it('also removes the alias, which a plain rm would leave behind', async () => {
    // The whole reason this command exists: `rm $(command -v better-md)` leaves a
    // 110 MB btr-md on PATH, still runnable.
    const dir = await installDir({ 'btr-md': 'BINARY' })

    const removed = await uninstall({ executable: path.join(dir, 'better-md'), log: () => {} })

    expect(removed.sort()).toEqual([path.join(dir, 'better-md'), path.join(dir, 'btr-md')].sort())
    await expect(fs.access(path.join(dir, 'btr-md'))).rejects.toThrow()
  })

  it('works when invoked as the alias, removing the primary too', async () => {
    const dir = await installDir({ 'btr-md': 'BINARY' })

    const removed = await uninstall({ executable: path.join(dir, 'btr-md'), log: () => {} })

    expect(removed.length).toBe(2)
  })

  it('leaves an unrelated file that merely shares the name', async () => {
    // Someone else's btr-md is not ours to delete. Identity is decided by content
    // matching the running binary, not by the filename.
    const dir = await installDir({ 'btr-md': 'SOMETHING ELSE ENTIRELY' })

    const removed = await uninstall({ executable: path.join(dir, 'better-md'), log: () => {} })

    expect(removed).toEqual([path.join(dir, 'better-md')])
    expect(await fs.readFile(path.join(dir, 'btr-md'), 'utf8')).toBe('SOMETHING ELSE ENTIRELY')
  })

  it('says which files it left alone', async () => {
    const dir = await installDir({ 'btr-md': 'SOMETHING ELSE ENTIRELY' })
    const logs: string[] = []

    await uninstall({ executable: path.join(dir, 'better-md'), log: (m) => logs.push(m) })

    // Silently skipping it would leave the user believing they are clean.
    expect(logs.join('\n')).toContain('btr-md')
  })

  it('refuses to uninstall a checkout rather than deleting node', async () => {
    await expect(uninstall({ executable: null, log: () => {} })).rejects.toThrow(
      /not an installed build/
    )
  })

  it('explains a permission failure instead of leaking errno', async () => {
    const dir = await installDir()
    await fs.chmod(dir, 0o555)
    cleanups.push(() => fs.chmod(dir, 0o755))

    await expect(
      uninstall({ executable: path.join(dir, 'better-md'), log: () => {} })
    ).rejects.toThrow(UninstallError)
  })
})
