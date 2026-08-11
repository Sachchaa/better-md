/**
 * Find and highlight text in a rendered document.
 *
 * The query is text the reader typed, not a pattern they wrote: `plan.md` must
 * not match `planXmd`, and a stray `[` must not throw. Both follow from treating
 * the query as literal, which is also why no regex is compiled from it at all.
 */
import { style } from './ansi.js'
import type { Line } from './render.js'

export interface Match {
  line: number
  /** Offsets into the line's *visible* text, ignoring escape sequences. */
  start: number
  end: number
}

// Same shape as wrap.ts's matcher; escape sequences carry no searchable text.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g

/** The line as the reader sees it, with the styling removed. */
function visible(text: string): string {
  return text.replace(ANSI, '')
}

export function findMatches(lines: Line[], query: string): Match[] {
  // An empty query matching every position would highlight the whole document
  // and make `n` meaningless.
  if (query === '') return []


  const needle = query.toLowerCase()
  const matches: Match[] = []

  lines.forEach((line, index) => {
    const haystack = visible(line.text).toLowerCase()
    // indexOf rather than a compiled pattern: literal by construction, so there
    // is nothing to escape and nothing that can throw.
    //
    // `from` strictly increases and is bounded by the line length, so this
    // terminates for any needle including an empty one. That is structural
    // rather than relying on the guard above: `indexOf('', n)` clamps to the
    // string length instead of returning -1, so a break on -1 alone spins
    // forever — synchronously, which no test timeout can interrupt.
    let from = 0
    while (from <= haystack.length) {
      const at = haystack.indexOf(needle, from)
      if (at === -1) break
      matches.push({ line: index, start: at, end: at + needle.length })
      from = Math.max(at + needle.length, from + 1)
    }
  })

  return matches
}

/** Move `current` by `delta`, wrapping at both ends. */
export function stepMatch(matches: Match[], current: number, delta: number): number {
  if (matches.length === 0) return 0
  // A reader pressing n at the last match wants the first one, not nothing.
  return (current + delta + matches.length) % matches.length
}

/**
 * Mark the matches on one line, the current one more strongly than the rest.
 *
 * Applied to the *visible* text: re-inserting the original escape codes around
 * arbitrary offsets would produce sequences that neither this code nor the
 * terminal can interpret.
 */
export function highlight(
  text: string,
  matches: Match[],
  current: number,
  colour: boolean
): string {
  if (matches.length === 0) return text

  const plain = visible(text)
  const ordered = [...matches].sort((a, b) => a.start - b.start)

  let out = ''
  let at = 0
  for (const match of ordered) {
    if (match.start < at) continue
    out += plain.slice(at, match.start)
    const found = plain.slice(match.start, match.end)
    // The current match is inverted, the rest bold: with several on screen the
    // reader needs to know which one `n` will move away from.
    out += style(found, matches.indexOf(match) === current ? 'inverse' : 'bold', {
      enabled: colour,
    })
    at = match.end
  }
  return out + plain.slice(at)
}
