import { describe, expect, it } from 'vitest'
import { setColourEnabled, style, supportsColour, supportsUnicode } from './ansi.js'

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
