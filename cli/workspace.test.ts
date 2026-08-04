import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ConflictError, NotFoundError, PathError, Workspace } from './workspace.js'

const dirs: string[] = []

async function fixture(): Promise<{ root: string; outside: string; ws: Workspace }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-ws-'))
  dirs.push(base)
  const root = path.join(base, 'root')
  const outside = path.join(base, 'outside')
  await fs.mkdir(root)
  await fs.mkdir(outside)
  await fs.mkdir(path.join(root, 'sub'))
  await fs.writeFile(path.join(root, 'notes.md'), '# notes', 'utf8')
  await fs.writeFile(path.join(root, 'sub', 'nested.md'), 'nested', 'utf8')
  await fs.writeFile(path.join(outside, 'secret.md'), 'SECRET', 'utf8')
  const ws = new Workspace({
    root: await fs.realpath(root),
    files: [{ name: 'notes.md', relPath: 'notes.md' }],
    active: 'notes.md',
  })
  return { root, outside, ws }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('Workspace path confinement', () => {
  const rejected: Array<[string, string]> = [
    ['parent traversal', '../outside/secret.md'],
    ['deep traversal', 'a/../../outside/secret.md'],
    ['absolute path', '/etc/passwd'],
    ['subdirectory', 'sub/nested.md'],
    ['null byte', 'notes\u0000.md'],
    ['empty string', ''],
    ['bare dot', '.'],
    ['percent-encoded traversal', '%2e%2e/secret.md'],
    ['disallowed extension', 'notes.exe'],
  ]

  for (const [label, relPath] of rejected) {
    it(`rejects ${label}`, async () => {
      const { ws } = await fixture()
      await expect(ws.read(relPath)).rejects.toThrow(PathError)
      await expect(ws.write(relPath, 'pwned', null)).rejects.toThrow(PathError)
    })
  }

  it('reads a confined file', async () => {
    const { ws } = await fixture()
    const doc = await ws.read('notes.md')
    expect(doc.content).toBe('# notes')
    expect(doc.relPath).toBe('notes.md')
    expect(doc.mtimeMs).toBeGreaterThan(0)
  })

  it('reports a missing document as NotFoundError, not a raw errno', async () => {
    const { ws } = await fixture()
    await expect(ws.read('ghost.md')).rejects.toThrow(NotFoundError)
  })
})

// A dangling symlink is the case that made the earlier implementation escape the
// root: realpath reports ENOENT for "nothing here" AND for "symlink with a missing
// target", so treating ENOENT as "safe to create" let writeFile follow the link and
// write outside the workspace. These two tests are the regression guard.
describe('Workspace symlink escapes', () => {
  it('refuses to read or write through a symlink pointing outside the root', async () => {
    const { root, outside, ws } = await fixture()
    await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'escape.md'))

    await expect(ws.read('escape.md')).rejects.toThrow(PathError)
    await expect(ws.write('escape.md', 'pwned', null)).rejects.toThrow(PathError)

    expect(await fs.readFile(path.join(outside, 'secret.md'), 'utf8')).toBe('SECRET')
  })

  it('refuses to write through a DANGLING symlink and creates nothing outside', async () => {
    const { root, outside, ws } = await fixture()
    const target = path.join(outside, 'implanted.md')
    await fs.symlink(target, path.join(root, 'escape.md'))

    await expect(ws.write('escape.md', 'PWNED', null)).rejects.toThrow(PathError)
    await expect(ws.write('escape.md', 'PWNED', 1_700_000_000_000)).rejects.toThrow(PathError)
    await expect(ws.read('escape.md')).rejects.toThrow(PathError)

    // The whole point: nothing may have appeared at the link's target.
    await expect(fs.access(target)).rejects.toThrow()
  })
})

describe('Workspace writes', () => {
  it('writes when the base mtime matches', async () => {
    const { root, ws } = await fixture()
    const before = await ws.read('notes.md')

    const result = await ws.write('notes.md', 'updated', before.mtimeMs)

    expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe('updated')
    expect(result.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs)
  })

  it('throws ConflictError when the file moved underneath', async () => {
    const { ws } = await fixture()
    const before = await ws.read('notes.md')

    await expect(ws.write('notes.md', 'mine', before.mtimeMs - 5000)).rejects.toThrow(ConflictError)
  })

  it('creates a new file when baseMtimeMs is null', async () => {
    const { root, ws } = await fixture()
    await ws.write('fresh.md', 'brand new', null)
    expect(await fs.readFile(path.join(root, 'fresh.md'), 'utf8')).toBe('brand new')
  })

  it('refuses to overwrite an existing file when baseMtimeMs is null', async () => {
    const { ws } = await fixture()
    await expect(ws.write('notes.md', 'clobber', null)).rejects.toThrow(ConflictError)
  })

  it('refuses a non-null base mtime when the file no longer exists', async () => {
    const { ws } = await fixture()
    await expect(ws.write('ghost.md', 'x', 1_700_000_000_000)).rejects.toThrow(ConflictError)
  })

  // Every conflict check is a positive comparison, and NaN makes all of them
  // false — so without an explicit guard a NaN base slips past all three and
  // overwrites the file. The HTTP layer builds this value from a JSON body.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses a %s base mtime instead of clobbering', async (_label, base) => {
    const { root, ws } = await fixture()

    await expect(ws.write('notes.md', 'CLOBBERED', base)).rejects.toThrow(PathError)

    expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe('# notes')
  })
})
