/**
 * Display-width measurement and wrapping.
 *
 * Everything laid out in the terminal is measured in columns, not characters:
 * CJK and emoji occupy two, combining marks occupy none, and escape sequences
 * occupy none while still being present in the string. Getting this wrong shows
 * up as ragged columns and boxes that do not close.
 */

// Matches SGR sequences, which is all this module emits. The ESC control
// character is the thing being matched, so no-control-regex cannot apply here.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g

/**
 * Column width of one code point.
 *
 * The wide ranges cover CJK, Hangul, Kana, fullwidth forms and the common emoji
 * planes. This is not a full Unicode East_Asian_Width table — that would be a
 * dependency or several hundred lines of generated data, and these ranges cover
 * what appears in agent-written Markdown.
 */
function charWidth(cp: number): number {
  if (cp === 0x200d) return 0 // zero-width joiner
  if (cp >= 0x0300 && cp <= 0x036f) return 0 // combining diacritics
  if (cp === 0xfe0f || cp === 0xfe0e) return 0 // variation selectors
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x2705 && cp <= 0x27bf)
  ) {
    return 2
  }
  return 1
}

export function displayWidth(text: string): number {
  let n = 0
  for (const ch of text.replace(ANSI, '')) n += charWidth(ch.codePointAt(0) ?? 0)
  return n
}

/** The longest prefix of `text` that fits in `width` columns. */
function prefixTo(text: string, width: number): string {
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0)
    if (used + w > width) break
    out += ch
    used += w
  }
  return out
}

/**
 * Wrap on spaces, breaking a word only when it cannot fit on a line of its own.
 *
 * Never returns a line wider than `width`: a line that overflows pushes every
 * column to its right off the screen, so an ugly break is the lesser failure.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text]
  const out: string[] = []
  let line = ''

  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`
    if (displayWidth(candidate) <= width) {
      line = candidate
      continue
    }
    if (line !== '') {
      out.push(line)
      line = ''
    }
    let rest = word
    while (displayWidth(rest) > width) {
      const cut = prefixTo(rest, width)
      // A width smaller than one wide character would loop forever otherwise.
      if (cut === '') break
      out.push(cut)
      rest = rest.slice(cut.length)
    }
    line = rest
  }
  out.push(line)
  return out
}

/**
 * Cut to `width` columns, marking the cut.
 *
 * Used for code-block content, which is shown verbatim rather than reflowed —
 * wrapping code changes what it says.
 */
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  if (width <= 1) return prefixTo(text, width)
  return `${prefixTo(text, width - 1)}…`
}
