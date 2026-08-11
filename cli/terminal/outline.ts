/**
 * The heading outline: a table of contents built from the rendered document.
 *
 * Derived from `Line[]` rather than from the blocks, so the ids and the line
 * numbers are the document's own. Deriving them a second time from the blocks
 * would mean two id generators over one document, and the first time they
 * disagreed a jump would land on the wrong section.
 */
import { style } from './ansi.js'
import type { Line, RenderOptions } from './render.js'
import { truncate } from './wrap.js'

export interface OutlineEntry {
  id: string
  level: number
  text: string
  /** Index into the `Line[]` this was built from. */
  line: number
}

export function buildOutline(lines: Line[]): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  lines.forEach((line, index) => {
    if (line.heading === undefined) return
    entries.push({ ...line.heading, line: index })
  })
  return entries
}

/**
 * Draw the outline, with one entry selected.
 *
 * Indented by heading level so the shape of the document is visible at a glance
 * — which is the only reason to open an outline rather than scroll.
 */
export function outlineLines(
  entries: OutlineEntry[],
  selected: number,
  o: RenderOptions
): string[] {
  if (entries.length === 0) {
    return [style('No headings in this document.', 'dim', { enabled: o.colour })]
  }

  const marker = o.unicode ? '▸' : '>'
  return entries.map((entry, index) => {
    const chosen = index === selected
    // Level 1 sits flush left; each level below it steps in two columns.
    const indent = '  '.repeat(Math.max(0, entry.level - 1))
    const lead = chosen ? `${marker} ` : '  '
    const text = truncate(`${indent}${lead}${entry.text}`, o.width)
    return chosen ? style(text, 'inverse', { enabled: o.colour }) : text
  })
}
