import { describe, expect, it } from 'vitest'
import {
  colourDepth,
  paint,
  PALETTE,
  setColourEnabled,
  style,
  supportsColour,
  supportsUnicode,
} from './ansi.js'

describe('colourDepth', () => {
  it('reports truecolor when COLORTERM says so', () => {
    expect(colourDepth({ TERM: 'xterm', COLORTERM: 'truecolor' }, true)).toBe('truecolor')
    expect(colourDepth({ TERM: 'xterm', COLORTERM: '24bit' }, true)).toBe('truecolor')
  })

  it('reports 256 for a 256-colour TERM', () => {
    expect(colourDepth({ TERM: 'xterm-256color' }, true)).toBe('ansi256')
  })

  it('falls back to the basic sixteen', () => {
    // A plain xterm still does colour. Refusing it entirely would leave the most
    // common ssh default monochrome.
    expect(colourDepth({ TERM: 'xterm' }, true)).toBe('basic')
  })

  it('reports none wherever colour must not be emitted', () => {
    expect(colourDepth({ TERM: 'xterm-256color', NO_COLOR: '1' }, true)).toBe('none')
    expect(colourDepth({ TERM: 'xterm-256color' }, false)).toBe('none')
    expect(colourDepth({ TERM: 'dumb' }, true)).toBe('none')
    expect(colourDepth({}, true)).toBe('none')
  })
})

describe('paint', () => {
  const brand = { r: 0xa8, g: 0xe0, b: 0x63, ansi256: 149, basic: 92 }

  it('uses a 24-bit sequence when the terminal has it', () => {
    expect(paint('x', brand, 'truecolor')).toBe('\x1b[38;2;168;224;99mx\x1b[39m')
  })

  it('uses the palette index at 256 colours', () => {
    expect(paint('x', brand, 'ansi256')).toBe('\x1b[38;5;149mx\x1b[39m')
  })

  it('falls back to a basic code', () => {
    expect(paint('x', brand, 'basic')).toBe('\x1b[92mx\x1b[39m')
  })

  it('returns the text untouched with no colour', () => {
    expect(paint('x', brand, 'none')).toBe('x')
  })

  it('closes the colour without resetting weight', () => {
    // A full reset would also clear bold, so a bold coloured heading would lose
    // its weight from the colour's end onwards.
    expect(paint('x', brand, 'ansi256')).toContain('\x1b[39m')
    expect(paint('x', brand, 'ansi256')).not.toContain('\x1b[0m')
  })
})

describe('the palette', () => {
  it('carries the brand green', () => {
    expect(PALETTE.brand).toMatchObject({ r: 0xa8, g: 0xe0, b: 0x63 })
  })

  it('gives code a colour that is not the brand, so headings stay distinct', () => {
    expect(PALETTE.code.ansi256).not.toBe(PALETTE.brand.ansi256)
  })

  it('has a border colour dimmer than body text', () => {
    const lum = (c: { r: number; g: number; b: number }): number =>
      0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
    expect(lum(PALETTE.border)).toBeLessThan(lum(PALETTE.text))
  })
})

describe('supportsColour', () => {
  it('is off when NO_COLOR is set, whatever else says', () => {
    // https://no-color.org — honouring it is the difference between a tool that
    // works in a pipeline and one that fills logs with escape codes.
    expect(supportsColour({ NO_COLOR: '1', TERM: 'xterm-256color' }, true)).toBe(false)
  })

  it('ignores an empty NO_COLOR, which is not set', () => {
    expect(supportsColour({ NO_COLOR: '', TERM: 'xterm-256color' }, true)).toBe(true)
  })

  it('is off when stdout is not a TTY', () => {
    expect(supportsColour({ TERM: 'xterm-256color' }, false)).toBe(false)
  })

  it('is off for TERM=dumb', () => {
    expect(supportsColour({ TERM: 'dumb' }, true)).toBe(false)
  })

  it('is off when TERM is unset', () => {
    expect(supportsColour({}, true)).toBe(false)
  })

  it('is on for a normal terminal', () => {
    expect(supportsColour({ TERM: 'xterm-256color' }, true)).toBe(true)
  })
})

describe('supportsUnicode', () => {
  it('needs a UTF-8 locale', () => {
    expect(supportsUnicode({ LANG: 'en_US.UTF-8' })).toBe(true)
    expect(supportsUnicode({ LC_ALL: 'C.utf8' })).toBe(true)
    expect(supportsUnicode({ LANG: 'C' })).toBe(false)
    expect(supportsUnicode({})).toBe(false)
  })

  it('prefers LC_ALL over LANG, as the shell does', () => {
    expect(supportsUnicode({ LC_ALL: 'C', LANG: 'en_US.UTF-8' })).toBe(false)
  })
})

describe('style', () => {
  it('wraps text in the code and always resets', () => {
    expect(style('x', 'bold', { enabled: true })).toBe('\x1b[1mx\x1b[0m')
  })

  it('returns text untouched when colour is off', () => {
    // The no-colour path lives inside style so every call site stays identical;
    // pushing the check out to callers is how half of them end up forgetting.
    expect(style('x', 'bold', { enabled: false })).toBe('x')
  })

  it('follows the module-level setting when not told otherwise', () => {
    setColourEnabled(false)
    expect(style('x', 'dim')).toBe('x')
    setColourEnabled(true)
    expect(style('x', 'dim')).toBe('\x1b[2mx\x1b[0m')
  })
})
