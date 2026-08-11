import { describe, expect, it, vi } from 'vitest'
import { EDITOR_HELP, openInEditor, resolveEditor, splitEditor } from './editor.js'

describe('resolveEditor', () => {
  it('prefers VISUAL over EDITOR', () => {
    // VISUAL is the full-screen editor; EDITOR may be a line editor like ed.
    expect(resolveEditor({ VISUAL: 'nvim', EDITOR: 'ed' })).toBe('nvim')
  })

  it('falls back to EDITOR', () => {
    expect(resolveEditor({ EDITOR: 'vi' })).toBe('vi')
  })

  it('is null when neither is set', () => {
    expect(resolveEditor({})).toBeNull()
  })

  it('treats an empty or blank value as unset', () => {
    // `EDITOR=` in a shell profile is common and means nothing is configured.
    expect(resolveEditor({ EDITOR: '' })).toBeNull()
    expect(resolveEditor({ VISUAL: '   ', EDITOR: 'vi' })).toBe('vi')
  })

  it('never guesses a binary', () => {
    // Spawning a guessed editor drops the reader into something they did not
    // choose and may not know how to leave.
    expect(resolveEditor({ PATH: '/usr/bin' })).toBeNull()
  })
})

describe('splitEditor', () => {
  it('splits a command from its arguments', () => {
    expect(splitEditor('code -w')).toEqual({ command: 'code', args: ['-w'] })
  })

  it('handles a bare command', () => {
    expect(splitEditor('nvim')).toEqual({ command: 'nvim', args: [] })
  })

  it('collapses repeated spaces rather than passing empty arguments', () => {
    expect(splitEditor('code   -w  --new-window')).toEqual({
      command: 'code',
      args: ['-w', '--new-window'],
    })
  })

  it('keeps a path that contains no spaces intact', () => {
    expect(splitEditor('/usr/local/bin/nvim -u NONE')).toEqual({
      command: '/usr/local/bin/nvim',
      args: ['-u', 'NONE'],
    })
  })
})

describe('openInEditor', () => {
  const spawned = (code: number | null, err?: Error) =>
    vi.fn(() => ({
      on: (event: string, fn: (arg: unknown) => void) => {
        if (event === 'exit' && err === undefined) setTimeout(() => fn(code), 0)
        if (event === 'error' && err !== undefined) setTimeout(() => fn(err), 0)
      },
    }))

  it('passes the file after the editor arguments', async () => {
    const spawn = spawned(0)
    await openInEditor('/plans/a.md', 'code -w', spawn as never)
    expect(spawn).toHaveBeenCalledWith('code', ['-w', '/plans/a.md'], { stdio: 'inherit' })
  })

  it('inherits stdio so the editor owns the terminal', async () => {
    // Without inherited stdio the editor draws into a pipe and the reader sees
    // a frozen screen.
    const spawn = spawned(0)
    await openInEditor('/plans/a.md', 'vi', spawn as never)
    expect(spawn).toHaveBeenCalledWith('vi', ['/plans/a.md'], { stdio: 'inherit' })
  })

  it('waits for the editor to exit', async () => {
    let exited = false
    const spawn = vi.fn(() => ({
      on: (event: string, fn: (arg: unknown) => void) => {
        if (event === 'exit')
          setTimeout(() => {
            exited = true
            fn(0)
          }, 10)
      },
    }))
    await openInEditor('/plans/a.md', 'vi', spawn as never)
    // Returning early would redraw over the editor the reader is still using.
    expect(exited).toBe(true)
  })

  it('resolves even when the editor exits non-zero', async () => {
    // `vi` exiting 1 is not the viewer's problem, and throwing here would take
    // the viewer down with it.
    await expect(openInEditor('/a.md', 'vi', spawned(1) as never)).resolves.toBeUndefined()
  })

  it('rejects when the editor cannot be started', async () => {
    const err = Object.assign(new Error('spawn nosuch ENOENT'), { code: 'ENOENT' })
    await expect(openInEditor('/a.md', 'nosuch', spawned(null, err) as never)).rejects.toThrow(
      'nosuch'
    )
  })
})

describe('EDITOR_HELP', () => {
  it('tells the reader what to set, with an example', () => {
    expect(EDITOR_HELP).toContain('No editor configured')
    expect(EDITOR_HELP).toContain('EDITOR')
  })
})
