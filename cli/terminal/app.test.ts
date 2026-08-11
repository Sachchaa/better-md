import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CURSOR_SHOW } from './ansi.js'
import { createApp } from './app.js'

const CTRL_C = '\x03'
const ESC = '\x1b'

function harness(markdown = '# Title\n\nbody', rows = 24) {
  const written: string[] = []
  const resizeListeners: Array<() => void> = []
  const input = new EventEmitter() as EventEmitter & {
    setRawMode?(on: boolean): void
    pause?(): void
  }
  const paused = vi.fn()
  const onInterrupt = vi.fn()
  let raw: boolean | null = null
  input.setRawMode = (on) => {
    raw = on
  }
  input.pause = paused
  const stopWatch = vi.fn()
  const read = vi.fn(() => (error === null ? Promise.resolve(content) : Promise.reject(error)))
  let content = markdown
  let error: Error | null = null
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
    onInterrupt,
  })

  return {
    app,
    written,
    input,
    stopWatch,
    paused,
    onInterrupt,
    read,
    out: () => written.join(''),
    /** What is on screen now: each draw writes exactly one frame. */
    frame: () => written[written.length - 1] ?? '',
    rawMode: () => raw,
    press: (key: string) => input.emit('data', key),
    resize: () => resizeListeners.forEach((fn) => fn()),
    change: (next: string) => {
      content = next
      error = null
      onChange()
    },
    /** Make the next read reject, as a deleted or unreadable file does. */
    fail: (err: Error) => {
      error = err
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
    // Pausing stdin is the only thing that lets the process exit: removing the
    // 'data' listener leaves the stream flowing, and a flowing stdin holds the
    // event loop open. Without it, `q` restored the terminal and then hung.
    expect(h.paused).toHaveBeenCalled()
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

  it('reports an interrupt separately from a deliberate quit', async () => {
    // Ctrl-C arrives as a byte in raw mode, not as SIGINT, so nothing outside the
    // key handler can tell it from `q`. A script reading $? should still see the
    // difference: 130 for an interrupt, 0 for quitting.
    const interrupted = harness()
    await interrupted.app.start()
    interrupted.press(CTRL_C)
    expect(interrupted.onInterrupt).toHaveBeenCalledTimes(1)

    const quit = harness()
    await quit.app.start()
    quit.press('q')
    expect(quit.onInterrupt).not.toHaveBeenCalled()
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

  it('survives the file being deleted under it', async () => {
    // An agent renaming or replacing a plan makes the next read throw. Letting
    // that reject unhandled kills the process with the terminal still in the
    // alt screen and raw mode on — the one failure with no easy recovery.
    const h = harness('# Here')
    await h.app.start()
    await h.reloaded(() => h.fail(new Error('ENOENT: no such file')))
    expect(h.frame()).not.toBe('')
    // Still watching, so the file coming back is picked up.
    await h.reloaded(() => h.change('# Back'))
    expect(h.frame()).toContain('Back')
    h.app.stop()
  })

  it('reports the read failure instead of showing stale content as current', async () => {
    const h = harness('# Here')
    await h.app.start()
    await h.reloaded(() => h.fail(new Error('EACCES: permission denied')))
    expect(h.frame()).toContain('EACCES')
    h.app.stop()
  })

  it('falls back to a sane size when the terminal reports none', async () => {
    // process.stdout.columns and rows are undefined off a tty despite the type
    // saying otherwise. Passing them through produced NaN arithmetic: a blank
    // pane and a footer reading "NaN%".
    const written: string[] = []
    const app = createApp({
      file: '/plans/a.md',
      read: () => Promise.resolve('# Title\n\nbody'),
      watch: () => () => {},
      tty: {
        write: (s) => written.push(s),
        columns: undefined as unknown as number,
        rows: undefined as unknown as number,
        isTTY: true,
        on: () => {},
        off: () => {},
      },
      input: new EventEmitter() as never,
      env: {},
    })
    await app.start()
    const frame = written[written.length - 1] ?? ''
    expect(frame).toContain('Title')
    expect(frame).toContain('body')
    expect(frame).not.toContain('NaN')
    app.stop()
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

  describe('the outline overlay', () => {
    const doc = `# Goal\n\nbody\n\n## Tasks\n\n${long}\n\n## Risks\n\nnone`

    it('opens on o and lists the headings', async () => {
      const h = harness(doc)
      await h.app.start()
      h.press('o')
      const frame = h.frame()
      expect(frame).toContain('Goal')
      expect(frame).toContain('Tasks')
      expect(frame).toContain('Risks')
      h.app.stop()
    })

    it('closes on o and on escape, leaving the document where it was', async () => {
      for (const key of ['o', ESC]) {
        const h = harness(doc)
        await h.app.start()
        const before = h.frame()
        h.press('o')
        expect(h.frame()).not.toBe(before)
        h.press(key)
        expect(h.frame()).toBe(before)
        h.app.stop()
      }
    })

    it('moves the selection with j and the arrows', async () => {
      const h = harness(doc)
      await h.app.start()
      h.press('o')
      const first = h.frame()
      h.press('j')
      expect(h.frame()).not.toBe(first)
      h.press('k')
      expect(h.frame()).toBe(first)
      h.app.stop()
    })

    it('does not run the selection off either end', async () => {
      const h = harness(doc)
      await h.app.start()
      h.press('o')
      const top = h.frame()
      h.press('k')
      expect(h.frame()).toBe(top)
      for (let i = 0; i < 20; i++) h.press('j')
      const bottom = h.frame()
      h.press('j')
      expect(h.frame()).toBe(bottom)
      h.app.stop()
    })

    it('scrolls to the chosen heading on enter and closes', async () => {
      const h = harness(doc)
      await h.app.start()
      h.press('o')
      h.press('j')
      h.press('j')
      h.press('\r')
      const frame = h.frame()
      // The overlay is gone and the document has moved to Risks.
      expect(frame).toContain('Risks')
      expect(frame).not.toContain('▸')
      h.app.stop()
    })

    it('leaves the document keys inert while it is open', async () => {
      // j moves the selection, not the page. Letting both happen means closing
      // the overlay drops the reader somewhere they never chose.
      //
      // G, g and space are the ones that matter here: they are not overlay keys,
      // so a fall-through would scroll the document invisibly behind the
      // overlay. Pressing only j proves nothing, since the overlay handles j.
      const h = harness(doc)
      await h.app.start()
      const start = h.frame()
      h.press('o')
      h.press('G')
      h.press(' ')
      h.press('j')
      h.press(ESC)
      // No `g` in that sequence: it scrolls back to the top, which is where the
      // document already was, so a leak would land back on `start` and the test
      // would pass while the bug was live.
      expect(h.frame()).toBe(start)
      h.app.stop()
    })

    it('still quits on q and on ctrl-c while open', async () => {
      // An overlay that swallows the quit key traps the reader.
      for (const key of ['q', CTRL_C]) {
        const h = harness(doc)
        await h.app.start()
        h.press('o')
        h.press(key)
        expect(h.frame()).toBe(CURSOR_SHOW + ALT_SCREEN_OFF)
      }
    })

    it('says so for a document with no headings', async () => {
      const h = harness('just prose, no headings at all')
      await h.app.start()
      h.press('o')
      expect(h.frame()).toContain('No headings')
      h.app.stop()
    })

    it('survives the document shrinking under an open overlay', async () => {
      // The agent rewrites the plan while the outline is open and the selected
      // heading is gone. Indexing blind would read past the end.
      const h = harness(doc)
      await h.app.start()
      h.press('o')
      for (let i = 0; i < 3; i++) h.press('j')
      await h.reloaded(() => h.change('# Only one heading now'))
      h.press('\r')
      expect(h.frame()).toContain('Only one heading now')
      h.app.stop()
    })
  })
})
