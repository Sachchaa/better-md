import { describe, expect, it } from 'vitest'
import { style } from './ansi.js'
import { displayWidth, truncate, wrap } from './wrap.js'

describe('displayWidth', () => {
  it('ignores escape sequences', () => {
    // Styled text gets measured for layout. Counting the escape bytes would make
    // every coloured line wrap early and leave ragged columns.
    expect(displayWidth(style('abc', 'bold', { enabled: true }))).toBe(3)
  })

  it('counts CJK as two columns', () => {
    expect(displayWidth('世界')).toBe(4)
  })

  it('counts a check mark and an emoji as two columns', () => {
    expect(displayWidth('✅')).toBe(2)
    expect(displayWidth('🚀')).toBe(2)
  })

  it('counts plain ASCII as one each', () => {
    expect(displayWidth('hello')).toBe(5)
  })

  it('gives a combining mark no width of its own', () => {
    expect(displayWidth('é')).toBe(1)
  })
})

describe('wrap', () => {
  it('breaks on spaces, not mid-word', () => {
    expect(wrap('the quick brown fox', 10)).toEqual(['the quick', 'brown fox'])
  })

  it('hard-breaks a word longer than the width', () => {
    // A 40-character URL in a 20-column pane has to go somewhere, and overflowing
    // the pane is worse than breaking the token.
    expect(wrap('aaaaaaaaaaaa', 5)).toEqual(['aaaaa', 'aaaaa', 'aa'])
  })

  it('returns one empty line for empty input', () => {
    expect(wrap('', 10)).toEqual([''])
  })

  it('never returns a line wider than the width, even with wide characters', () => {
    for (const line of wrap('世界 hello 世界世界 a', 7)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(7)
    }
  })

  it('measures columns, not characters', () => {
    // '世界世' is three characters but six columns. Anything measuring .length
    // keeps it on a five-column line and overflows the pane — and the previous
    // version of the test above happened not to produce that case.
    for (const line of wrap('世界世 abc', 5)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(5)
    }
  })

  it('keeps text intact when it already fits', () => {
    expect(wrap('short', 40)).toEqual(['short'])
  })
})

describe('truncate', () => {
  it('leaves text that fits', () => {
    expect(truncate('abc', 5)).toBe('abc')
  })

  it('cuts to the width including the ellipsis', () => {
    // Code blocks truncate rather than wrap, so the marker has to fit inside the
    // budget or the line still overflows.
    expect(displayWidth(truncate('abcdefghij', 6))).toBeLessThanOrEqual(6)
    expect(truncate('abcdefghij', 6)).toContain('…')
  })

  it('does not split a wide character across the cut', () => {
    const out = truncate('世界世界世界', 5)
    expect(displayWidth(out)).toBeLessThanOrEqual(5)
  })
})
