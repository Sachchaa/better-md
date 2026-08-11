/**
 * Decode one raw stdin read into a keypress.
 *
 * In raw mode stdin delivers bytes, not events: an arrow key arrives as three
 * bytes beginning with the same 0x1b that Escape sends alone. Deciding between
 * them by length is the whole job, and getting it wrong closes an overlay the
 * moment the reader tries to move inside it.
 */

/** Every key that is not a printable character. */
export type KeyName =
  | 'up'
  | 'down'
  | 'pageup'
  | 'pagedown'
  | 'enter'
  | 'escape'
  | 'backspace'
  | 'ctrl-c'

export type Key = { name: 'char'; value: string } | { name: KeyName }

const ESC = '\x1b'

const SEQUENCES: Record<string, KeyName> = {
  [`${ESC}[A`]: 'up',
  [`${ESC}[B`]: 'down',
  [`${ESC}[5~`]: 'pageup',
  [`${ESC}[6~`]: 'pagedown',
}

/** Returns null for anything unrecognised — never a literal control byte. */
export function decodeKey(data: string): Key | null {
  const sequence = SEQUENCES[data]
  if (sequence !== undefined) return { name: sequence }

  // Bare 0x1b only, checked after the sequences above so an arrow key cannot
  // fall through to Escape.
  if (data === ESC) return { name: 'escape' }
  if (data === '\r' || data === '\n') return { name: 'enter' }
  if (data === '\x03') return { name: 'ctrl-c' }
  if (data === '\x7f' || data === '\x08') return { name: 'backspace' }

  // Anything left starting with a control byte is dropped whole rather than
  // typed: an unhandled escape sequence (a function key, a bracketed paste
  // marker, a mouse report) leads with 0x1b, and a stray 0x01 in a search box
  // corrupts the query and prints as a replacement glyph.
  const codePoint = data.codePointAt(0)
  if (codePoint === undefined || codePoint < 0x20) return null
  return { name: 'char', value: data }
}
