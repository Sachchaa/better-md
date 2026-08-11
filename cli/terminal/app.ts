/**
 * The viewer shell: read, render, draw, and hand the terminal back intact.
 *
 * Every capability the shell touches — the tty, stdin, the clock's worth of
 * file watching, the environment — arrives through `AppOptions`, so the whole
 * thing is driven by a fake emitter in tests. No pty, no screen snapshots, and
 * no global process state: the signal and exit handlers live in the caller so
 * these tests need no cleanup.
 */
import { basename } from 'node:path'
import { parseBlocks } from '../blocks.js'
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  CLEAR,
  CURSOR_HIDE,
  CURSOR_SHOW,
  moveTo,
  style,
  supportsColour,
  supportsUnicode,
} from './ansi.js'
import { decodeKeys, type Key } from './keys.js'
import { renderDocument, type Line } from './render.js'
import {
  anchorAt,
  clamp,
  pageBy,
  restoreAnchor,
  scrollBy,
  toBottom,
  toTop,
  type Viewport,
} from './viewport.js'
import { displayWidth, truncate } from './wrap.js'

export interface Tty {
  write(s: string): void
  columns: number
  rows: number
  isTTY: boolean
  on(event: 'resize', fn: () => void): void
  off(event: 'resize', fn: () => void): void
}

export interface AppOptions {
  file: string
  read: () => Promise<string>
  watch: (onChange: () => void) => () => void
  tty: Tty
  input: NodeJS.EventEmitter & { setRawMode?(on: boolean): void }
  env: NodeJS.ProcessEnv
}

export interface App {
  start(): Promise<void>
  /** Idempotent: safe to call from an exit handler and from the quit key. */
  stop(): void
}

/**
 * How long to wait for a file to settle before re-reading.
 *
 * An agent rewriting a plan touches it many times a second; repainting on every
 * event makes the pane unreadable and the reads pile up behind each other.
 */
const SETTLE_MS = 150

/** Header and footer each take a row. */
const CHROME_ROWS = 2

export function createApp(options: AppOptions): App {
  const { tty, input, env } = options

  let stopped = false
  let lines: Line[] = []
  let view: Viewport = { top: 0, height: 0, total: 0 }
  let unwatch: (() => void) | null = null
  let onResize: (() => void) | null = null
  let onData: ((data: Buffer | string) => void) | null = null
  let settle: NodeJS.Timeout | null = null
  let loading: Promise<void> = Promise.resolve()

  const colour = (): boolean => supportsColour(env, tty.isTTY)

  const bodyHeight = (): number => Math.max(1, tty.rows - CHROME_ROWS)

  const chrome = (text: string): string =>
    style(truncate(text, tty.columns), 'inverse', { enabled: colour() })

  const header = (): string => {
    const name = basename(options.file)
    const pad = ' '.repeat(Math.max(0, tty.columns - displayWidth(name) - 1))
    return chrome(` ${name}${pad}`)
  }

  const footer = (): string => {
    const end = Math.min(view.total, view.top + view.height)
    const percent = view.total === 0 ? 100 : Math.round((end / view.total) * 100)
    const left = ` ${percent}%`
    const right = 'q quit  j/k scroll  g/G ends '
    const pad = ' '.repeat(
      Math.max(1, tty.columns - displayWidth(left) - displayWidth(right))
    )
    return chrome(`${left}${pad}${right}`)
  }

  const draw = (): void => {
    // The last gate before any write, and the only guarantee that nothing paints
    // over the shell after it has been handed back: keypresses buffered behind
    // the quit key, a resize mid-shutdown, and a reload landing late all end up
    // here.
    if (stopped) return
    const height = bodyHeight()
    const body = lines
      .slice(view.top, view.top + height)
      .map((l) => truncate(l.text, tty.columns))
    // Pad to a full pane so a shorter document does not leave the previous
    // frame's lines behind it.
    while (body.length < height) body.push('')
    tty.write(
      CLEAR + moveTo(1, 1) + header() + '\r\n' + body.join('\r\n') + '\r\n' + footer()
    )
  }

  const load = async (): Promise<void> => {
    // A line number is worthless once the agent has rewritten the file: text
    // inserted above shifts every offset. Anchor to the heading above the view
    // and keep the distance from it, so a reader deep inside a section stays
    // there instead of being pulled back to its heading.
    const anchor = anchorAt(lines, view.top)
    const from = anchor === null ? -1 : lines.findIndex((l) => l.headingId === anchor)
    const offset = from === -1 ? 0 : view.top - from

    const markdown = await options.read()
    if (stopped) return
    lines = renderDocument(parseBlocks(markdown), {
      width: tty.columns,
      unicode: supportsUnicode(env),
      colour: colour(),
    })

    // -1 as the fallback distinguishes "the heading is gone" from "the heading
    // is now the first line"; a deleted heading leaves the old offset as the
    // only thing left to aim at.
    const to = restoreAnchor(lines, anchor, -1)
    view = clamp({
      top: to === -1 ? view.top : to + offset,
      height: bodyHeight(),
      total: lines.length,
    })
    draw()
  }

  /** Serialised: two overlapping reads would race to set `lines`. */
  const reload = (): void => {
    loading = loading.then(load, load)
  }

  const move = (next: Viewport): void => {
    view = next
    draw()
  }

  const handle = (k: Key): void => {
    if (k.name === 'ctrl-c' || (k.name === 'char' && k.value === 'q')) {
      stop()
      return
    }
    if (k.name === 'up') return move(scrollBy(view, -1))
    if (k.name === 'down') return move(scrollBy(view, 1))
    if (k.name === 'pageup') return move(pageBy(view, -1))
    if (k.name === 'pagedown') return move(pageBy(view, 1))
    if (k.name !== 'char') return

    switch (k.value) {
      case 'k':
        return move(scrollBy(view, -1))
      case 'j':
        return move(scrollBy(view, 1))
      case ' ':
      case 'f':
        return move(pageBy(view, 1))
      case 'b':
        return move(pageBy(view, -1))
      case 'g':
        return move(toTop(view))
      case 'G':
        return move(toBottom(view))
      case 'r':
        return reload()
      default:
        return
    }
  }

  const start = async (): Promise<void> => {
    tty.write(ALT_SCREEN_ON + CURSOR_HIDE)
    input.setRawMode?.(true)

    onData = (data) => {
      // One chunk can carry the quit key and whatever was typed behind it;
      // `draw` refuses to paint once stopped, so the tail is inert.
      for (const key of decodeKeys(data.toString())) handle(key)
    }
    input.on('data', onData)

    onResize = () => {
      if (stopped) return
      // A narrower pane rewraps every line, so the document is re-rendered
      // rather than just re-sliced.
      reload()
      view = clamp({ ...view, height: bodyHeight() })
      draw()
    }
    tty.on('resize', onResize)

    unwatch = options.watch(() => {
      if (settle !== null) clearTimeout(settle)
      settle = setTimeout(() => {
        settle = null
        reload()
      }, SETTLE_MS)
      // Never hold the process open on the debounce alone.
      settle.unref?.()
    })

    reload()
    await loading
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (settle !== null) clearTimeout(settle)
    unwatch?.()
    if (onData !== null) input.off('data', onData)
    if (onResize !== null) tty.off('resize', onResize)
    input.setRawMode?.(false)
    tty.write(CURSOR_SHOW + ALT_SCREEN_OFF)
  }

  return { start, stop }
}
