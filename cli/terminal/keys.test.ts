import { describe, expect, it } from 'vitest'
import { decodeKey, decodeKeys } from './keys.js'

const ESC = '\x1b'

describe('decodeKey', () => {
  it.each([
    [`${ESC}[A`, 'up'],
    [`${ESC}[B`, 'down'],
    [`${ESC}[5~`, 'pageup'],
    [`${ESC}[6~`, 'pagedown'],
    ['\r', 'enter'],
    ['\n', 'enter'],
    [ESC, 'escape'],
    ['\x03', 'ctrl-c'],
    ['\x7f', 'backspace'],
    ['\x08', 'backspace'],
  ])('decodes %j as %s', (bytes, name) => {
    expect(decodeKey(bytes)).toEqual({ name })
  })

  it('passes printable characters through', () => {
    expect(decodeKey('j')).toEqual({ name: 'char', value: 'j' })
    expect(decodeKey('/')).toEqual({ name: 'char', value: '/' })
  })

  it('does not mistake an arrow sequence for the escape key', () => {
    // Both start with 0x1b. Treating the arrow prefix as Escape closes overlays
    // the moment the user tries to move inside one.
    expect(decodeKey(`${ESC}[A`)).not.toEqual({ name: 'escape' })
  })

  it('ignores an unknown escape sequence rather than typing it', () => {
    expect(decodeKey(`${ESC}[200~`)).toBeNull()
  })

  it('ignores the remaining control characters rather than typing them', () => {
    // A stray 0x01 inserted into a search box as a literal byte corrupts the
    // query and prints as a replacement glyph.
    expect(decodeKey('\x01')).toBeNull()
    expect(decodeKey('\x1f')).toBeNull()
  })

  it('accepts a multi-byte character as one keypress', () => {
    // A paste or an IME sends the whole code point in one read.
    expect(decodeKey('é')).toEqual({ name: 'char', value: 'é' })
  })
})

describe('decodeKeys', () => {
  it('splits a batched chunk into one key per press', () => {
    // Key repeat and paste both deliver several keys in one read. Decoding the
    // chunk as a single key drops every one of them.
    expect(decodeKeys('jjj')).toEqual([
      { name: 'char', value: 'j' },
      { name: 'char', value: 'j' },
      { name: 'char', value: 'j' },
    ])
  })

  it('keeps an escape sequence whole among plain characters', () => {
    expect(decodeKeys(`q${ESC}[Bk`)).toEqual([
      { name: 'char', value: 'q' },
      { name: 'down' },
      { name: 'char', value: 'k' },
    ])
  })

  it('drops an unknown sequence without eating the key after it', () => {
    expect(decodeKeys(`${ESC}[200~j`)).toEqual([{ name: 'char', value: 'j' }])
  })

  it('treats a trailing lone escape as the escape key', () => {
    expect(decodeKeys(`j${ESC}`)).toEqual([{ name: 'char', value: 'j' }, { name: 'escape' }])
  })

  it('reads escape followed by a key as two keypresses', () => {
    // Escape then q, typed fast enough to arrive in one read, must still quit.
    // Treating the pair as Alt-q swallowed both.
    expect(decodeKeys(`${ESC}q`)).toEqual([{ name: 'escape' }, { name: 'char', value: 'q' }])
    expect(decodeKeys(`${ESC}j`)).toEqual([{ name: 'escape' }, { name: 'char', value: 'j' }])
  })

  it('does not split a character that needs two code units', () => {
    expect(decodeKeys('🚀')).toEqual([{ name: 'char', value: '🚀' }])
  })

  it('returns nothing for an empty read', () => {
    expect(decodeKeys('')).toEqual([])
  })
})
