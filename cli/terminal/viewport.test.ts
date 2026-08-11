import { describe, expect, it } from 'vitest'
import { anchorAt, clamp, pageBy, restoreAnchor, scrollBy, scrollToLine, toBottom, toTop } from './viewport.js'

const v = (top: number, height = 10, total = 100) => clamp({ top, height, total })

describe('scrolling', () => {
  it('cannot scroll above the start', () => {
    expect(scrollBy(v(0), -5).top).toBe(0)
  })

  it('stops with the last line visible, not past it', () => {
    // Scrolling into blank space below the document is the classic pager bug.
    expect(toBottom(v(0)).top).toBe(90)
    expect(scrollBy(v(90), 50).top).toBe(90)
  })

  it('does not scroll at all when the document fits', () => {
    expect(toBottom(clamp({ top: 0, height: 50, total: 20 })).top).toBe(0)
  })

  it('pages by a screen less one line of context', () => {
    expect(pageBy(v(0), 1).top).toBe(9)
  })

  it('pages backwards by the same amount', () => {
    expect(pageBy(v(20), -1).top).toBe(11)
  })

  it('returns to the start', () => {
    expect(toTop(v(50)).top).toBe(0)
  })

  it('leaves context above a line it scrolls to', () => {
    // A jump target sitting on the very first row hides what it belongs to.
    // Asserting `<= 40` would pass with no offset at all, which is the bug this
    // test exists to catch.
    expect(scrollToLine(v(0), 40).top).toBeLessThan(40)
  })

  it('leaves more context in a taller pane', () => {
    // Proportional, not a fixed line or two: one line of headroom in an
    // 80-row terminal still reads as pinned to the edge.
    const short = scrollToLine(v(0, 10, 200), 100).top
    const tall = scrollToLine(v(0, 80, 200), 100).top
    expect(100 - tall).toBeGreaterThan(100 - short)
  })

  it('clamps a scroll target past the end back to the last screen', () => {
    expect(scrollToLine(v(0), 500).top).toBe(90)
  })

  it('keeps a height larger than the document from producing a negative top', () => {
    expect(clamp({ top: 5, height: 40, total: 3 }).top).toBe(0)
  })
})

describe('anchoring across a reload', () => {
  const lines = [
    { text: 'Goal', headingId: 'goal' },
    { text: 'body' },
    { text: 'Tasks', headingId: 'tasks' },
    { text: 'body' },
  ]

  it('reports the heading owning the top of the view', () => {
    expect(anchorAt(lines, 3)).toBe('tasks')
    expect(anchorAt(lines, 1)).toBe('goal')
  })

  it('is null above the first heading', () => {
    expect(anchorAt([{ text: 'preamble' }], 0)).toBeNull()
  })

  it('finds the same heading after the document grows above it', () => {
    // The agent appended a section higher up; the reader should stay on Tasks
    // rather than being thrown back to wherever line 3 now points.
    const grown = [{ text: 'new' }, { text: 'new' }, ...lines]
    expect(restoreAnchor(grown, 'tasks', 3)).toBe(4)
  })

  it('falls back to the old offset when the heading is gone', () => {
    expect(restoreAnchor([{ text: 'x' }], 'tasks', 3)).toBe(3)
  })

  it('falls back when there was no anchor to begin with', () => {
    expect(restoreAnchor(lines, null, 2)).toBe(2)
  })
})
