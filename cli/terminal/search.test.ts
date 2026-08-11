import { describe, expect, it } from 'vitest'
import { style } from './ansi.js'
import { findMatches, highlight, stepMatch } from './search.js'

// The escape byte is the thing being matched, so no-control-regex cannot apply.
/* eslint-disable no-control-regex */
const ANSI = /\x1b\[[0-9;]*m/g
const MARKED = /\x1b\[7m|\x1b\[1m/g
/* eslint-enable no-control-regex */

const lines = (...texts: string[]) => texts.map((text) => ({ text }))

describe('findMatches', () => {
  it('finds a match and reports where it is', () => {
    expect(findMatches(lines('the plan is ready'), 'plan')).toEqual([
      { line: 0, start: 4, end: 8 },
    ])
  })

  it('ignores case', () => {
    expect(findMatches(lines('The Plan'), 'plan')).toHaveLength(1)
    expect(findMatches(lines('the plan'), 'PLAN')).toHaveLength(1)
  })

  it('returns matches in document order', () => {
    const found = findMatches(lines('plan one', 'nothing', 'plan two'), 'plan')
    expect(found.map((m) => m.line)).toEqual([0, 2])
  })

  it('finds every match on a line, not just the first', () => {
    expect(findMatches(lines('plan plan plan'), 'plan')).toHaveLength(3)
  })

  it('returns nothing for a query that does not appear', () => {
    expect(findMatches(lines('the plan'), 'zebra')).toEqual([])
  })

  it('returns nothing for an empty query rather than matching everywhere', () => {
    expect(findMatches(lines('the plan'), '')).toEqual([])
  })

  it('matches regex metacharacters literally', () => {
    // Someone searching for plan.md must not be shown planXmd. The query is
    // text the reader typed, not a pattern they wrote.
    expect(findMatches(lines('planXmd'), 'plan.md')).toEqual([])
    expect(findMatches(lines('see plan.md now'), 'plan.md')).toHaveLength(1)
  })

  it('does not blow up on a query that is not valid regex', () => {
    // An unescaped `[` or `(` would throw when compiled. A reader typing a
    // bracket should get no matches, not a crash that takes the viewer down.
    for (const query of ['[', '(', '*', '\\', '+?', 'a)b']) {
      expect(() => findMatches(lines('some text'), query)).not.toThrow()
    }
    expect(findMatches(lines('an [aside] here'), '[aside]')).toHaveLength(1)
  })

  it('measures positions on the visible text, not the escape codes', () => {
    // Rendered lines carry styling. Offsets counted through the escape bytes
    // would highlight the wrong columns.
    const styled = [{ text: `a ${style('plan', 'bold', { enabled: true })} here` }]
    const [match] = findMatches(styled, 'plan')
    expect(match.start).toBe(2)
    expect(match.end).toBe(6)
  })
})

describe('stepMatch', () => {
  const three = [
    { line: 1, start: 0, end: 4 },
    { line: 5, start: 0, end: 4 },
    { line: 9, start: 0, end: 4 },
  ]

  it('advances and goes back', () => {
    expect(stepMatch(three, 0, 1)).toBe(1)
    expect(stepMatch(three, 1, -1)).toBe(0)
  })

  it('wraps around both ends', () => {
    // A reader pressing n at the last match wants the first one, not nothing.
    expect(stepMatch(three, 2, 1)).toBe(0)
    expect(stepMatch(three, 0, -1)).toBe(2)
  })

  it('stays at zero when there is nothing to step through', () => {
    expect(stepMatch([], 0, 1)).toBe(0)
  })
})

describe('highlight', () => {
  it('marks the matched text', () => {
    const out = highlight('the plan is ready', [{ line: 0, start: 4, end: 8 }], 0, true)
    expect(out).toContain('plan')
    expect(out).not.toBe('the plan is ready')
  })

  it('leaves a line with no matches untouched', () => {
    expect(highlight('nothing here', [], 0, true)).toBe('nothing here')
  })

  it('marks every match on the line', () => {
    const matches = [
      { line: 0, start: 0, end: 4 },
      { line: 0, start: 5, end: 9 },
    ]
    const out = highlight('plan plan', matches, 0, true)
    // Both marked, and the text still reads as itself.
    expect(out.replace(ANSI, '')).toBe('plan plan')
    expect(out.match(MARKED)?.length).toBe(2)
  })

  it('keeps the text readable when styling is off', () => {
    expect(highlight('the plan', [{ line: 0, start: 4, end: 8 }], 0, false)).toBe('the plan')
  })
})
