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

/** Escape-sequence terminators: the byte that ends a CSI or SS3 sequence. */
function isFinal(ch: string): boolean {
  return ch >= '@' && ch <= '~'
}

/**
 * Split one raw read into its keypresses.
 *
 * A single stdin chunk is not a single key: holding `j` under key repeat, or
 * pasting, delivers several at once. Handing the whole chunk to `decodeKey`
 * yields one nonsense char and drops the lot, which reads as scrolling that
 * sticks.
 */
export function decodeKeys(data: string): Key[] {
  const keys: Key[] = []
  let i = 0

  while (i < data.length) {
    let token: string
    if (data[i] !== ESC) {
      // Consume a whole code point: splitting a surrogate pair mid-way turns one
      // pasted character into two broken halves.
      const cp = data.codePointAt(i)
      token = data.slice(i, i + (cp !== undefined && cp > 0xffff ? 2 : 1))
    } else if (data[i + 1] === '[' || data[i + 1] === 'O') {
      let end = i + 2
      while (end < data.length && !isFinal(data[end])) end++
      token = data.slice(i, Math.min(end + 1, data.length))
    } else if (i + 1 < data.length) {
      // ESC followed by a character is Alt-<key>, which this viewer does not use.
      token = data.slice(i, i + 2)
    } else {
      token = ESC
    }

    i += token.length
    const key = decodeKey(token)
    if (key !== null) keys.push(key)
  }

  return keys
}
