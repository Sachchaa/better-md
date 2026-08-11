import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'

const ESC = '\x1b'

// The escape byte is the thing being matched, so no-control-regex cannot apply.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
const seen = (s: string): string => s.replace(ANSI, '')

function harness(markdown = '# Title\n\nbody') {
  const written: string[] = []
  const input = new EventEmitter() as EventEmitter & {
    setRawMode?(on: boolean): void
    pause?(): void
  }
  input.setRawMode = () => {}
  input.pause = () => {}
  const read = vi.fn(() => (error === null ? Promise.resolve(content) : Promise.reject(error)))
  let content = markdown
  let error: Error | null = null
  let onChange: () => void = () => {}

  const app = createApp({
    file: '/plans/a.md',
    read,
    watch: (fn) => {
      onChange = fn
      return () => {}
    },
    tty: {
      write: (s) => written.push(s),
      columns: 80,
      rows: 24,
      isTTY: true,
      on: () => {},
      off: () => {},
    },
    input,
    env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
  })

  return {
    app,
    read,
    frame: () => seen(written[written.length - 1] ?? ''),
    press: (key: string) => input.emit('data', key),
    change: (next: string) => {
      content = next
      // The file exists again: leaving the injected error in place would keep
      // reporting a removal no matter what the content said.
      error = null
      onChange()
    },
    remove: () => {
      error = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      onChange()
    },
    changed: async (act: () => void) => {
      const before = read.mock.calls.length
      const frames = written.length
      act()
      await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before))
      await vi.waitFor(() => expect(written.length).toBeGreaterThan(frames))
    },
  }
}

describe('the status indicator', () => {
  it('starts out watching', async () => {
    const h = harness()
    await h.app.start()
    expect(h.frame()).toContain('Watching')
    h.app.stop()
  })

  it('reports an update when the file changes', async () => {
    // Without this, a live reload is indistinguishable from nothing happening —
    // the reader cannot tell whether their agent has written yet.
    const h = harness('# One')
    await h.app.start()
    await h.changed(() => h.change('# Two'))
    expect(h.frame()).toContain('Updated')
    h.app.stop()
  })

  it('settles back to watching after a couple of seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const h = harness('# One')
      await h.app.start()
      await h.changed(() => h.change('# Two'))
      expect(h.frame()).toContain('Updated')
      await vi.advanceTimersByTimeAsync(2100)
      expect(h.frame()).toContain('Watching')
    } finally {
      vi.useRealTimers()
    }
  })

  it('says the file is gone rather than crashing', async () => {
    const h = harness('# One')
    await h.app.start()
    await h.changed(() => h.remove())
    expect(h.frame()).toContain('File removed')
    h.app.stop()
  })

  it('keeps watching after a removal, so the file coming back is picked up', async () => {
    const h = harness('# One')
    await h.app.start()
    await h.changed(() => h.remove())
    await h.changed(() => h.change('# Back'))
    expect(h.frame()).toContain('Back')
    expect(h.frame()).not.toContain('File removed')
    h.app.stop()
  })
})

describe('the empty document', () => {
  it('says it is empty rather than showing a blank pane', async () => {
    // A blank pane reads as a broken viewer. The file really is empty.
    const h = harness('')
    await h.app.start()
    expect(h.frame()).toContain('This Markdown file is empty.')
    h.app.stop()
  })

  it('is still watching, so the first thing written appears', async () => {
    const h = harness('')
    await h.app.start()
    expect(h.frame()).toContain('Watching')
    await h.changed(() => h.change('# First heading'))
    expect(h.frame()).toContain('First heading')
    h.app.stop()
  })

  it('treats whitespace-only content as empty', async () => {
    const h = harness('\n\n   \n')
    await h.app.start()
    expect(h.frame()).toContain('This Markdown file is empty.')
    h.app.stop()
  })
})

describe('the help overlay', () => {
  it('opens on ? and lists the keys', async () => {
    const h = harness()
    await h.app.start()
    h.press('?')
    const frame = h.frame()
    for (const key of ['search', 'outline', 'editor', 'browser', 'quit']) {
      expect(frame).toContain(key)
    }
    h.app.stop()
  })

  it('closes on ? and on escape', async () => {
    for (const key of ['?', ESC]) {
      const h = harness()
      await h.app.start()
      const before = h.frame()
      h.press('?')
      expect(h.frame()).not.toBe(before)
      h.press(key)
      expect(h.frame()).toBe(before)
      h.app.stop()
    }
  })

  it('leaves the document keys inert while it is open', async () => {
    const h = harness(`# Long\n\n${Array.from({ length: 80 }, (_, i) => `row-${i}`).join('\n\n')}`)
    await h.app.start()
    const before = h.frame()
    h.press('?')
    h.press('G')
    h.press('j')
    h.press(ESC)
    expect(h.frame()).toBe(before)
    h.app.stop()
  })

  it('still quits on q', async () => {
    const h = harness()
    await h.app.start()
    h.press('?')
    h.press('q')
    expect(h.frame()).toBe('')
    h.app.stop()
  })

  it('keeps the footer short, with the full list in the overlay', async () => {
    // The footer is one line on an 80-column terminal. Everything cannot fit,
    // so it advertises the overlay instead of truncating a list of keys.
    const h = harness()
    await h.app.start()
    const footer = h.frame().split('\n').pop() ?? ''
    expect(footer).toContain('? help')
    expect(footer.length).toBeLessThanOrEqual(80)
    h.app.stop()
  })
})
