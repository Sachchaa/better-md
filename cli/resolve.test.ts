import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ResolveError, resolveWorkspace } from './resolve.js'
import type { CliOptions } from './types.js'

const dirs: string[] = []

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-resolve-'))
  dirs.push(dir)
  return dir
}

function opts(over: Partial<CliOptions>): CliOptions {
  return {
    target: null,
    plan: false,
    port: 0,
    open: false,
    agent: null,
    detach: false,
    terminal: false,
    command: null,
    initTarget: null,
    write: false,
    checkUpdates: false,
    ...over,
  }
}

/** Write a file with an explicit mtime so "newest" ordering is deterministic. */
async function writeAt(dir: string, name: string, body: string, epochMs: number): Promise<void> {
  const full = path.join(dir, name)
  await fs.writeFile(full, body, 'utf8')
  const when = new Date(epochMs)
  await fs.utimes(full, when, when)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('resolveWorkspace', () => {
  it('resolves a single file to its parent directory', async () => {
    const dir = await tmpDir()
    await writeAt(dir, 'notes.md', '# hi', 1_000_000)

    const ws = await resolveWorkspace(opts({ target: path.join(dir, 'notes.md') }))

    expect(ws.root).toBe(await fs.realpath(dir))
    expect(ws.files).toEqual([{ name: 'notes.md', relPath: 'notes.md' }])
    expect(ws.active).toBe('notes.md')
  })

  it('lists a directory alphabetically and activates the first entry', async () => {
    const dir = await tmpDir()
    await writeAt(dir, 'zeta.md', 'z', 3_000_000)
    await writeAt(dir, 'alpha.markdown', 'a', 1_000_000)
    await writeAt(dir, 'notes.txt', 'n', 2_000_000)
    await writeAt(dir, 'ignored.png', 'x', 2_000_000)

    const ws = await resolveWorkspace(opts({ target: dir }))

    expect(ws.files.map((f) => f.relPath)).toEqual(['alpha.markdown', 'notes.txt', 'zeta.md'])
    expect(ws.active).toBe('alpha.markdown')
  })

  it('activates the newest file for --plan but lists them all', async () => {
    const plans = await tmpDir()
    await writeAt(plans, 'older.md', 'o', 1_000_000)
    await writeAt(plans, 'newest.md', 'n', 9_000_000)
    await writeAt(plans, 'middle.md', 'm', 5_000_000)

    const ws = await resolveWorkspace(opts({ plan: true }), plans)

    expect(ws.active).toBe('newest.md')
    expect(ws.files.map((f) => f.relPath).sort()).toEqual(['middle.md', 'newest.md', 'older.md'])
  })

  // Every negative path asserts the error TYPE as well as the message. The type is
  // the contract Task 6's entry point relies on (`err instanceof ResolveError` picks
  // a clean one-line CLI error over a stack trace), so a regression that threw a bare
  // Error with matching text must not pass.
  it('errors when the target does not exist', async () => {
    const dir = await tmpDir()
    const call = resolveWorkspace(opts({ target: path.join(dir, 'nope.md') }))
    await expect(call).rejects.toThrow(ResolveError)
    await expect(call).rejects.toThrow(/no such file or directory/)
  })

  it('errors when a directory holds no documents', async () => {
    const dir = await tmpDir()
    await expect(resolveWorkspace(opts({ target: dir }))).rejects.toThrow(ResolveError)
  })

  it('errors when the target is a file with an unsupported extension', async () => {
    const dir = await tmpDir()
    await writeAt(dir, 'image.png', 'not markdown', 1_000_000)
    const call = resolveWorkspace(opts({ target: path.join(dir, 'image.png') }))
    await expect(call).rejects.toThrow(ResolveError)
    await expect(call).rejects.toThrow(/not a markdown file/)
  })

  it('errors with an install hint when the plans directory is missing', async () => {
    const dir = await tmpDir()
    const missing = path.join(dir, 'no-plans-here')
    const call = resolveWorkspace(opts({ plan: true }), missing)
    await expect(call).rejects.toThrow(ResolveError)
    await expect(call).rejects.toThrow(/Is Claude Code installed\?/)
  })

  it('errors when the plans directory exists but is empty', async () => {
    const plans = await tmpDir()
    const call = resolveWorkspace(opts({ plan: true }), plans)
    await expect(call).rejects.toThrow(ResolveError)
    await expect(call).rejects.toThrow(/Is Claude Code installed\?/)
  })
})
