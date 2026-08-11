import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CURSOR_SHOW } from './ansi.js'
import { createApp } from './app.js'

const CTRL_C = '\x03'
const ESC = '\x1b'

function harness(markdown = '# Title\n\nbody', rows = 24) {
  const written: string[] = []
  const resizeListeners: Array<() => void> = []
  const input = new EventEmitter() as EventEmitter & { setRawMode?(on: boolean): void }
  let raw: boolean | null = null
  input.setRawMode = (on) => {
    raw = on
  }
  const stopWatch = vi.fn()
  const read = vi.fn(() => Promise.resolve(content))
  let content = markdown
  let onChange: () => void = () => {}

  const app = createApp({
    file: '/plans/a.md',
    read,
    watch: (fn) => {
      onChange = fn
      return stopWatch
    },
    tty: {
      write: (s) => written.push(s),
      columns: 80,
      rows,
      isTTY: true,
      on: (_e, fn) => resizeListeners.push(fn),
      off: () => {},
    },
    input,
    env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
  })

  return {
    app,
    written,
    input,
    stopWatch,
    read,
    out: () => written.join(''),
    /** What is on screen now: each draw writes exactly one frame. */
    frame: () => written[written.length - 1] ?? '',
    rawMode: () => raw,
    press: (key: string) => input.emit('data', key),
    resize: () => resizeListeners.forEach((fn) => fn()),
    change: (next: string) => {
      content = next
      onChange()
    },
    /**
     * Run `act`, then wait for the debounced re-read and its repaint to land.
     *
     * Waiting on a new frame rather than on new frame *content*: when the
     * reading position is held perfectly the repaint is byte-identical to what
     * was already on screen, so comparing content would wait forever on a
     * working app. The frame count still moves, because the draw still happens.
     */
    reloaded: async (act: () => void): Promise<void> => {
      const reads = read.mock.calls.length
      const frames = written.length
      act()
      await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(reads))
      await vi.waitFor(() => expect(written.length).toBeGreaterThan(frames))
    },
  }
}

/**
 * A document tall enough that the 24-row harness must scroll it.
 *
 * Zero-padded so an assertion for `item-001` cannot be satisfied by `item-010`
 * — the substring collision that made an earlier version of the paging test
 * pass for the wrong reason.
 */
const long = Array.from({ length: 120 }, (_, i) => `item-${String(i).padStart(3, '0')}`).join(
  '\n\n'
)

describe('createApp', () => {
  it('enters the alt screen and renders the document', async () => {
    const h = harness()
    await h.app.start()
    expect(h.out()).toContain(ALT_SCREEN_ON)
    expect(h.out()).toContain('Title')
    h.app.stop()
  })

  it('shows the file name so the reader knows what they are looking at', async () => {
    const h = harness()
    await h.app.start()
    expect(h.out()).toContain('a.md')
    h.app.stop()
  })

  it('restores the terminal on stop', async () => {
    const h = harness()
    await h.app.start()
    h.app.stop()
    // The failure this prevents is a shell left in raw mode with no cursor —
    // the user's only recovery is `reset`, and they will not know that.
    expect(h.out()).toContain(ALT_SCREEN_OFF)
    expect(h.out()).toContain(CURSOR_SHOW)
    expect(h.rawMode()).toBe(false)
    expect(h.stopWatch).toHaveBeenCalled()
  })

  it('restores exactly once even if stop is called twice', async () => {
    const h = harness()
    await h.app.start()
    h.app.stop()
    const after = h.written.length
    h.app.stop()
    expect(h.written.length).toBe(after)
    expect(h.stopWatch).toHaveBeenCalledTimes(1)
  })

  it.each([['q'], [CTRL_C]])('quits on %j', async (key) => {
    const h = harness()
    await h.app.start()
    h.press(key)
    expect(h.out()).toContain(ALT_SCREEN_OFF)
  })

  // Asserted as "the restore is the last thing written" rather than as a write
  // count: counting after the chunk already includes the frames the tail
  // painted, which is why an earlier version of these two passed with no guard
  // at all.
  const RESTORED = CURSOR_SHOW + ALT_SCREEN_OFF

  it('paints nothing after a keypress that arrives once it has stopped', async () => {
    const h = harness(long)
    await h.app.start()
    h.press('q')
    h.press('j')
    expect(h.frame()).toBe(RESTORED)
  })

  it('paints nothing for the keys buffered behind the quit key', async () => {
    // Key repeat delivers several keys per read, so `q` and what follows it
    // arrive in one chunk. The tail must not paint over the restored shell.
    const h = harness(long)
    await h.app.start()
    h.press('qjjj')
    expect(h.frame()).toBe(RESTORED)
  })

  it('acts on every key in a batched chunk', async () => {
    // Holding j sends them batched; one chunk must not scroll by one line.
    const h = harness(long)
    await h.app.start()
    const single = harness(long)
    await single.app.start()
    single.press('j')
    h.press('jjjjj')
    expect(h.frame()).not.toBe(single.frame())
    h.app.stop()
    single.app.stop()
  })

  it('redraws on resize', async () => {
    const h = harness()
    await h.app.start()
    const before = h.written.length
    h.resize()
    expect(h.written.length).toBeGreaterThan(before)
    h.app.stop()
  })

  it('re-reads and re-renders when the file changes', async () => {
    const h = harness('# One')
    await h.app.start()
    h.change('# Two')
    await vi.waitFor(() => expect(h.out()).toContain('Two'))
    h.app.stop()
  })

  it('coalesces a burst of writes into one re-read', async () => {
    // An agent rewriting a plan touches the file many times a second. Reading
    // and repainting on every event makes the pane unreadable.
    const h = harness('# One')
    await h.app.start()
    const before = h.read.mock.calls.length
    for (let i = 0; i < 20; i++) h.change(`# Take ${i}`)
    await vi.waitFor(() => expect(h.out()).toContain('Take 19'))
    expect(h.read.mock.calls.length - before).toBeLessThan(5)
    h.app.stop()
  })

  it('keeps the reading position across a reload', async () => {
    const h = harness(`# Goal\n\nbody\n\n## Tasks\n\n${long}`)
    await h.app.start()
    h.press('G')
    // Asserted against the current frame, not h.out(): the accumulated buffer
    // still holds the pre-reload frame, so a whole-buffer assertion passes even
    // when the reload jumps back to line 0.
    //
    // The wait is on the re-read rather than on the frame changing: when the
    // position is held perfectly the new frame is byte-identical to the old one,
    // so "the frame changed" would wait forever on a working app.
    await h.reloaded(() => h.change(`# Goal\n\nnew paragraph\n\nbody\n\n## Tasks\n\n${long}`))
    expect(h.frame()).toContain('item-119')
    h.app.stop()
  })

  it('keeps the position inside a section, not just the section', async () => {
    // The agent inserts a paragraph above while the reader is deep inside a
    // later section. Landing them back on that section's heading loses their
    // place just as surely as landing them at the top of the file.
    const h = harness(`# Goal\n\nbody\n\n## Tasks\n\n${long}`)
    await h.app.start()
    for (let i = 0; i < 30; i++) h.press('j')
    const before = h.frame()
    await h.reloaded(() => h.change(`# Goal\n\nnew paragraph\n\nbody\n\n## Tasks\n\n${long}`))

    const item = (n: number) => `item-${String(n).padStart(3, '0')}`
    const firstVisible = (frame: string): number | undefined =>
      Array.from({ length: 120 }, (_, i) => i).find((i) => frame.includes(item(i)))
    const top = firstVisible(before)
    expect(top).toBeGreaterThan(0)
    // The same item still on screen, rather than the section heading above it.
    expect(h.frame()).toContain(item(top as number))
    h.app.stop()
  })

  describe('scrolling', () => {
    const at = (h: ReturnType<typeof harness>, text: string) => h.out().includes(text)

    it('scrolls down with j and the down arrow', async () => {
      for (const key of ['j', `${ESC}[B`]) {
        const h = harness(long)
        await h.app.start()
        expect(at(h, 'item-000')).toBe(true)
        h.press(key)
        expect(h.frame()).not.toContain('item-000')
        h.app.stop()
      }
    })

    it('goes to the end with G and back to the start with g', async () => {
      const h = harness(long)
      await h.app.start()
      h.press('G')
      expect(h.frame()).toContain('item-119')
      h.press('g')
      expect(h.frame()).toContain('item-000')
      h.app.stop()
    })

    it('pages with the space bar', async () => {
      const h = harness(long)
      await h.app.start()
      h.press(' ')
      // A page is further than a single line, which is the whole point of it.
      expect(h.frame()).not.toContain('item-001')
      h.app.stop()
    })

    it('does not scroll past the end', async () => {
      const h = harness(long)
      await h.app.start()
      h.press('G')
      expect(h.frame()).toContain('item-119')
      for (let i = 0; i < 40; i++) h.press('j')
      expect(h.frame()).toContain('item-119')
      h.app.stop()
    })

    it('does not scroll a document that already fits', async () => {
      const h = harness('# Short\n\nonly this')
      await h.app.start()
      h.press('G')
      expect(h.frame()).toContain('only this')
      h.app.stop()
    })
  })
})
