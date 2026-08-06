import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { HOOK_MATCHER, InitError, initClaude, settingsPath } from './initAgent.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

async function home(settings?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-init-'))
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
  if (settings !== undefined) {
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true })
    await fs.writeFile(settingsPath(dir), settings, 'utf8')
  }
  return dir
}

const read = async (dir: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(settingsPath(dir), 'utf8')) as Record<string, unknown>

describe('initClaude', () => {
  it('previews without writing unless asked', async () => {
    const dir = await home('{"model":"opus"}')

    const result = await initClaude({ home: dir, program: 'better-md', write: false })

    expect(result.changed).toBe(true)
    expect(result.written).toBe(false)
    expect(result.block).toContain(HOOK_MATCHER)
    expect(await read(dir)).toEqual({ model: 'opus' })
  })

  it('adds the hook while preserving every existing setting', async () => {
    // The real file holds model, plugins, permissions and a status line.
    // Clobbering it to add one hook would be far worse than not installing.
    const dir = await home(
      JSON.stringify({
        model: 'opus',
        permissions: { defaultMode: 'bypassPermissions' },
        enabledPlugins: { 'superpowers@official': true },
      })
    )

    await initClaude({ home: dir, program: 'better-md', write: true })

    const after = await read(dir)
    expect(after.model).toBe('opus')
    expect(after.permissions).toEqual({ defaultMode: 'bypassPermissions' })
    expect(after.enabledPlugins).toEqual({ 'superpowers@official': true })
    expect(JSON.stringify(after.hooks)).toContain(HOOK_MATCHER)
  })

  it('keeps hooks that were already configured', async () => {
    const dir = await home(
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier' }] }],
        },
      })
    )

    await initClaude({ home: dir, program: 'better-md', write: true })

    const hooks = (await read(dir)).hooks as Record<string, unknown[]>
    expect(hooks.PostToolUse).toHaveLength(2)
    expect(JSON.stringify(hooks.PostToolUse[0])).toContain('prettier')
  })

  it('installs the hook as async', async () => {
    // --plan runs a server until stopped. A blocking hook would hang the very
    // turn that produced the plan.
    const dir = await home()
    await initClaude({ home: dir, program: 'better-md', write: true })

    const hooks = (await read(dir)).hooks as Record<string, Array<{ hooks: unknown[] }>>
    expect(hooks.PostToolUse[0].hooks[0]).toMatchObject({ async: true, type: 'command' })
  })

  it('is idempotent — running it twice adds one hook', async () => {
    const dir = await home()

    await initClaude({ home: dir, program: 'better-md', write: true })
    const second = await initClaude({ home: dir, program: 'better-md', write: true })

    expect(second.changed).toBe(false)
    expect(second.written).toBe(false)
    const hooks = (await read(dir)).hooks as Record<string, unknown[]>
    expect(hooks.PostToolUse).toHaveLength(1)
  })

  it('creates settings.json when there is none', async () => {
    const dir = await home()
    await initClaude({ home: dir, program: 'better-md', write: true })
    expect(JSON.stringify(await read(dir))).toContain(HOOK_MATCHER)
  })

  it('refuses a malformed settings.json rather than replacing it', async () => {
    const dir = await home('{ this is not json')

    await expect(initClaude({ home: dir, program: 'better-md', write: true })).rejects.toThrow(
      InitError
    )
    // Untouched: a broken settings.json disables every setting in it, so
    // overwriting could cost far more than the hook is worth.
    expect(await fs.readFile(settingsPath(dir), 'utf8')).toBe('{ this is not json')
  })

  it('names the invoking program so the alias installs itself', async () => {
    const dir = await home()
    const result = await initClaude({ home: dir, program: 'btr-md', write: false })
    expect(result.block).toContain('btr-md --plan --detach')
  })
})
