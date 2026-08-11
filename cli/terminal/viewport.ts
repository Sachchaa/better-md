/**
 * Scroll position, as arithmetic.
 *
 * Kept apart from the app loop and free of any terminal handle so the awkward
 * cases — a document shorter than the pane, a scroll past the end, a file that
 * grew above where you were reading — are settled by tests rather than by
 * watching the screen.
 */
import type { Line } from './render.js'

export interface Viewport {
  top: number
  height: number
  total: number
}

/**
 * Bound `top` so the last line lands on the last row and no further.
 *
 * Every other function here routes through this: scrolling into blank space
 * below a document is the classic pager bug, and a document shorter than the
 * pane must not scroll at all.
 */
export function clamp(v: Viewport): Viewport {
  const max = Math.max(0, v.total - v.height)
  return { ...v, top: Math.min(max, Math.max(0, v.top)) }
}

export function scrollBy(v: Viewport, delta: number): Viewport {
  return clamp({ ...v, top: v.top + delta })
}

/** One line of overlap per page, so the reader keeps a thread across the jump. */
export function pageBy(v: Viewport, pages: number): Viewport {
  return scrollBy(v, pages * (v.height - 1))
}

export function toTop(v: Viewport): Viewport {
  return clamp({ ...v, top: 0 })
}

export function toBottom(v: Viewport): Viewport {
  return clamp({ ...v, top: v.total })
}

/**
 * Bring `line` into view with a little room above it.
 *
 * A jump target pinned to the very top row loses the context that says what it
 * belongs to, so leave an eighth of the pane above it.
 */
export function scrollToLine(v: Viewport, line: number): Viewport {
  return clamp({ ...v, top: line - Math.floor(v.height / 8) })
}

/**
 * The heading that owns the top of the view.
 *
 * This is the anchor carried across a reload. A line offset is worthless once
 * the agent has rewritten the file: text inserted above shifts every number.
 */
export function anchorAt(lines: Line[], top: number): string | null {
  for (let i = Math.min(top, lines.length - 1); i >= 0; i--) {
    const id = lines[i]?.headingId
    if (id !== undefined) return id
  }
  return null
}

/** Where that anchor sits in a freshly rendered document. */
export function restoreAnchor(lines: Line[], anchor: string | null, fallback: number): number {
  if (anchor === null) return fallback
  const found = lines.findIndex((l) => l.headingId === anchor)
  // A heading the agent deleted or renamed leaves nothing to aim at, so hold
  // the old offset rather than jumping the reader to the top.
  return found === -1 ? fallback : found
}
