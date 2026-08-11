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
import { EDITOR_HELP, resolveEditor } from './editor.js'
import { decodeKeys, type Key } from './keys.js'
import { buildOutline, outlineLines, type OutlineEntry } from './outline.js'
import { findMatches, highlight, stepMatch, type Match } from './search.js'
import { renderDocument, type Line } from './render.js'
import {
  anchorAt,
  clamp,
  pageBy,
  restoreAnchor,
  scrollBy,
  scrollToLine,
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
  /**
   * Called when the reader interrupts with Ctrl-C, rather than quitting with q.
   *
   * In raw mode Ctrl-C arrives as byte 0x03, not as SIGINT, so nothing else can
   * tell the two apart — and a script checking `$?` should see 130 for an
   * interrupt and 0 for a deliberate quit.
   */
  onInterrupt?: () => void
  /**
   * Run the reader's editor on the file and resolve when it closes.
   *
   * Injected so the app never spawns anything itself: the tests drive the whole
   * hand-over-and-take-back sequence without a real editor.
   */
  edit?: (file: string, editor: string) => Promise<void>
  input: NodeJS.EventEmitter & {
    setRawMode?(on: boolean): void
    /**
     * Pausing on shutdown is what lets the process exit.
     *
     * Removing the last 'data' listener does not pause the stream, and a flowing
     * stdin holds the event loop open forever: without this, `q` restored the
     * terminal and then never gave the shell back.
     */
    pause?(): void
    resume?(): void
  }
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

/**
 * Assumed size when the terminal reports none.
 *
 * `process.stdout.columns` and `.rows` are `undefined` whenever stdout is not a
 * tty, despite the Node types declaring them `number`. Trusting the type gave
 * NaN arithmetic: a blank pane and a footer reading "NaN%".
 */
const DEFAULT_COLUMNS = 80
const DEFAULT_ROWS = 24

export function createApp(options: AppOptions): App {
  const { tty, input, env } = options

  let stopped = false
  let lines: Line[] = []
  let view: Viewport = { top: 0, height: 0, total: 0 }
  let unwatch: (() => void) | null = null
  let onResize: (() => void) | null = null
  let onData: ((data: Buffer | string) => void) | null = null
  let settle: NodeJS.Timeout | null = null
  /** Set when the last read failed; cleared by the next one that succeeds. */
  let failure: string | null = null
  /**
   * A message for the reader, shown above the document until a key dismisses it.
   *
   * Separate from `failure`, which describes the *file*: a successful read clears
   * a read error, and an editor that could not start would otherwise have its
   * message wiped by the re-read that follows.
   */
  let notice: string | null = null
  /** True while an external editor owns the terminal. */
  let editing = false
  /** Non-null while the outline overlay is open, holding the selected index. */
  let outline: { selected: number } | null = null
  /**
   * The search state.
   *
   * `typing` is true while the prompt is open, which is what makes every
   * printable key part of the query rather than a navigation command.
   */
  let search: { query: string; typing: boolean; matches: Match[]; current: number } | null = null
  let loading: Promise<void> = Promise.resolve()

  const colour = (): boolean => supportsColour(env, tty.isTTY)

  const columns = (): number =>
    Number.isFinite(tty.columns) && tty.columns > 0 ? tty.columns : DEFAULT_COLUMNS

  const rows = (): number =>
    Number.isFinite(tty.rows) && tty.rows > 0 ? tty.rows : DEFAULT_ROWS

  const bodyHeight = (): number => Math.max(1, rows() - CHROME_ROWS)

  const chrome = (text: string): string =>
    style(truncate(text, columns()), 'inverse', { enabled: colour() })

  const header = (): string => {
    const name = basename(options.file)
    const pad = ' '.repeat(Math.max(0, columns() - displayWidth(name) - 1))
    return chrome(` ${name}${pad}`)
  }

  const footer = (): string => {
    if (search !== null && search.typing) return chrome(` /${search.query}`)

    const end = Math.min(view.total, view.top + view.height)
    const percent = view.total === 0 ? 100 : Math.round((end / view.total) * 100)
    const left =
      search === null
        ? ` ${percent}%`
        : search.matches.length === 0
          ? ` No match for "${search.query}"`
          : ` ${search.current + 1}/${search.matches.length} for "${search.query}"`
    const right = outline === null ? 'q quit  j/k scroll  o outline ' : 'enter open  esc close '
    const pad = ' '.repeat(
      Math.max(1, columns() - displayWidth(left) - displayWidth(right))
    )
    return chrome(`${left}${pad}${right}`)
  }

  const draw = (): void => {
    // The last gate before any write, and the only guarantee that nothing paints
    // over the shell after it has been handed back: keypresses buffered behind
    // the quit key, a resize mid-shutdown, and a reload landing late all end up
    // here.
    // Nothing is drawn while an external editor owns the screen: a frame painted
    // over an open editor corrupts what the reader is working in.
    if (stopped || editing) return

    const banner = [
      ...(notice === null
        ? []
        : notice
            .split('\n')
            .map((l) => style(truncate(l, columns()), 'bold', { enabled: colour() }))),
      ...(failure === null
        ? []
        : [style(truncate(`! ${failure}`, columns()), 'bold', { enabled: colour() })]),
    ]
    const height = Math.max(1, bodyHeight() - banner.length)
    const body =
      outline === null
        ? lines.slice(view.top, view.top + height).map((l, offset) => {
            const index = view.top + offset
            const onLine = search?.matches.filter((m) => m.line === index) ?? []
            if (onLine.length === 0) return truncate(l.text, columns())
            const current = search?.matches[search.current]
            return truncate(
              highlight(
                l.text,
                onLine,
                current === undefined ? -1 : onLine.indexOf(current),
                colour()
              ),
              columns()
            )
          })
        : outlineLines(buildOutline(lines), outline.selected, {
            width: columns(),
            unicode: supportsUnicode(env),
            colour: colour(),
          }).slice(0, height)
    // Pad to a full pane so a shorter document does not leave the previous
    // frame's lines behind it.
    while (body.length < height) body.push('')
    tty.write(
      CLEAR +
        moveTo(1, 1) +
        [header(), ...banner, ...body, footer()].join('\r\n')
    )
  }

  const load = async (): Promise<void> => {
    // A line number is worthless once the agent has rewritten the file: text
    // inserted above shifts every offset. Anchor to the heading above the view
    // and keep the distance from it, so a reader deep inside a section stays
    // there instead of being pulled back to its heading.
    const anchor = anchorAt(lines, view.top)
    const from = anchor === null ? -1 : lines.findIndex((l) => l.heading?.id === anchor)
    const offset = from === -1 ? 0 : view.top - from

    let markdown: string
    try {
      markdown = await options.read()
    } catch (err) {
      // An agent renaming or replacing a plan makes this read throw. Letting the
      // rejection escape kills the process with the terminal still in the alt
      // screen and raw mode on, which is the one failure a user cannot easily
      // recover from. The last good document stays on screen under a banner
      // saying why it is not current, and the watcher keeps running so the file
      // coming back is picked up.
      failure = err instanceof Error ? err.message : String(err)
      draw()
      return
    }
    failure = null
    if (stopped) return
    lines = renderDocument(parseBlocks(markdown), {
      width: columns(),
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
    research()
    draw()
  }

  /** Serialised: two overlapping reads would race to set `lines`. */
  const reload = (): void => {
    loading = loading.then(load, load)
  }

  /**
   * Hand the terminal to the reader's editor, then take it back.
   *
   * The editor needs the terminal as it found it — cooked mode, cursor visible,
   * off the alt screen — and the viewer needs all three back afterwards. The
   * file is re-read on return because changing it was the point.
   */
  const runEditor = async (): Promise<void> => {
    const editor = resolveEditor(env)
    if (editor === null) {
      // No guessing: spawning whatever is installed drops the reader into an
      // editor they did not choose and may not know how to leave.
      notice = EDITOR_HELP
      draw()
      return
    }
    if (options.edit === undefined) return

    editing = true
    input.setRawMode?.(false)
    input.pause?.()
    tty.write(CURSOR_SHOW + ALT_SCREEN_OFF)

    try {
      await options.edit(options.file, editor)
      notice = null
    } catch (err) {
      // A typo in $EDITOR must not leave the reader with no viewer and no
      // editor, so the message lands in the viewer rather than the void. As a
      // notice, not a failure: the re-read below would clear a failure.
      notice = err instanceof Error ? err.message : String(err)
    } finally {
      editing = false
      if (!stopped) {
        tty.write(ALT_SCREEN_ON + CURSOR_HIDE)
        input.setRawMode?.(true)
        input.resume?.()
      }
    }

    reload()
  }

  const move = (next: Viewport): void => {
    view = next
    draw()
  }

  /**
   * Keys while the outline is open.
   *
   * Returns true when the key belonged to the overlay, so the document's own
   * bindings stay inert: `j` moving both the selection and the page would drop
   * the reader somewhere they never chose.
   */
  const handleOutline = (k: Key, entries: OutlineEntry[]): boolean => {
    if (outline === null) return false

    if (k.name === 'escape' || (k.name === 'char' && k.value === 'o')) {
      outline = null
      draw()
      return true
    }

    if (k.name === 'enter') {
      const entry = entries[outline.selected]
      outline = null
      // The document may have been rewritten while the overlay was open, so the
      // selected index can point past the end of the new outline.
      if (entry !== undefined) view = scrollToLine(view, entry.line)
      draw()
      return true
    }

    const step =
      k.name === 'down' || (k.name === 'char' && k.value === 'j')
        ? 1
        : k.name === 'up' || (k.name === 'char' && k.value === 'k')
          ? -1
          : 0
    if (step !== 0) {
      outline.selected = Math.min(
        Math.max(0, entries.length - 1),
        Math.max(0, outline.selected + step)
      )
      draw()
      return true
    }

    // Anything else is swallowed rather than passed through: an overlay that
    // lets G scroll the document behind it is just confusing.
    return true
  }

  /** Recompute the matches against the document as it is now. */
  const research = (): void => {
    if (search === null) return
    search.matches = findMatches(lines, search.query)
    // The document may have been rewritten under an active search, leaving the
    // old index pointing past the end of the new match list.
    search.current = Math.min(search.current, Math.max(0, search.matches.length - 1))
  }

  const showMatch = (): void => {
    const match = search?.matches[search.current]
    if (match !== undefined) view = scrollToLine(view, match.line)
    draw()
  }

  /**
   * Keys while the search prompt is open.
   *
   * Every printable key is part of the query: g, G, n and j are all ordinary
   * letters to someone typing, and treating them as navigation would scroll the
   * page out from under the prompt.
   */
  const handleTyping = (k: Key): boolean => {
    if (search === null || !search.typing) return false

    if (k.name === 'escape') {
      search = null
      draw()
      return true
    }
    if (k.name === 'enter') {
      search.typing = false
      research()
      showMatch()
      return true
    }
    if (k.name === 'backspace') {
      search.query = search.query.slice(0, -1)
      draw()
      return true
    }
    if (k.name === 'char') {
      search.query += k.value
      draw()
      return true
    }
    // Arrows and page keys are ignored rather than passed through, so the page
    // cannot move while the prompt is open.
    return true
  }

  const handle = (k: Key): void => {
    if (k.name === 'ctrl-c') {
      stop()
      options.onInterrupt?.()
      return
    }
    if (k.name === 'char' && k.value === 'q') {
      stop()
      return
    }
    if (notice !== null) {
      // Any key dismisses the message, and does nothing else: the reader was
      // reading, not navigating, so acting on the same key would surprise them.
      notice = null
      draw()
      return
    }
    // Both checked after quit, so neither can trap the reader.
    if (handleTyping(k)) return
    if (handleOutline(k, buildOutline(lines))) return
    if (k.name === 'escape') {
      // Clears the highlighting left behind once the prompt has closed.
      if (search === null) return
      search = null
      draw()
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
      case 'o':
        outline = { selected: 0 }
        draw()
        return
      case '/':
        search = { query: '', typing: true, matches: [], current: 0 }
        draw()
        return
      case 'n':
        if (search === null) return
        research()
        search.current = stepMatch(search.matches, search.current, 1)
        return showMatch()
      case 'N':
        if (search === null) return
        research()
        search.current = stepMatch(search.matches, search.current, -1)
        return showMatch()
      case 'e':
        void runEditor()
        return
      case 'r':
        return reload()
      default:
        return
    }
  }

  const start = async (): Promise<void> => {
    tty.write(ALT_SCREEN_ON + CURSOR_HIDE)
    input.setRawMode?.(true)
    input.resume?.()

    onData = (data) => {
      // Whatever is typed while an editor holds the terminal belongs to the
      // editor. stdin is paused then, but a chunk already in flight would
      // otherwise scroll a document nobody can see.
      if (editing) return
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
    // Removing the listener is not enough: a flowing stdin keeps the event loop
    // alive, so the process would hold the shell forever after the terminal had
    // already been handed back.
    input.pause?.()
    tty.write(CURSOR_SHOW + ALT_SCREEN_OFF)
  }

  return { start, stop }
}
