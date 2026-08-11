import { describe, expect, it } from 'vitest'
import { parseBlocks } from '../blocks.js'
import { buildOutline, outlineLines } from './outline.js'
import { renderDocument } from './render.js'

const plain = { width: 60, unicode: true, colour: false }
const outlineOf = (md: string) => buildOutline(renderDocument(parseBlocks(md), plain))

describe('buildOutline', () => {
  it('lists every heading in document order', () => {
    const entries = outlineOf('# One\n\nbody\n\n## Two\n\n### Three\n\n# Four')
    expect(entries.map((e) => e.text)).toEqual(['One', 'Two', 'Three', 'Four'])
  })

  it('records the level, so nesting comes from the heading not the source layout', () => {
    const entries = outlineOf('# One\n\n### Deep')
    expect(entries.map((e) => e.level)).toEqual([1, 3])
  })

  it('is empty for a document with no headings', () => {
    expect(outlineOf('just a paragraph')).toEqual([])
    expect(outlineOf('')).toEqual([])
  })

  it('points at the line to scroll to', () => {
    const lines = renderDocument(parseBlocks('# One\n\nbody\n\n## Two'), plain)
    const entries = buildOutline(lines)
    // The recorded line is the heading itself, not an approximation of it.
    for (const entry of entries) {
      expect(lines[entry.line]?.heading?.id).toBe(entry.id)
    }
  })

  it('carries the same ids the document was rendered with', () => {
    // Two "## Tasks" headings are ordinary in a plan. If the outline generated
    // its own ids they would drift from the document's and the jump would land
    // on the wrong section.
    const lines = renderDocument(parseBlocks('## Tasks\n\na\n\n## Tasks\n\nb'), plain)
    const entries = buildOutline(lines)
    expect(entries).toHaveLength(2)
    expect(entries[0].id).not.toBe(entries[1].id)
    expect(entries.map((e) => e.line)).toEqual(
      lines.flatMap((l, i) => (l.heading === undefined ? [] : [i]))
    )
  })

  it('shows the heading text without its inline markers', () => {
    expect(outlineOf('# The **real** goal')[0].text).toBe('The real goal')
  })
})

describe('outlineLines', () => {
  const entries = [
    { id: 'goal', level: 1, text: 'Goal', line: 0 },
    { id: 'tasks', level: 2, text: 'Tasks', line: 10 },
    { id: 'one', level: 3, text: 'Step one', line: 12 },
  ]

  it('indents by heading level', () => {
    const rendered = outlineLines(entries, 0, { width: 40, unicode: true, colour: false })
    const indent = (s: string) => s.length - s.trimStart().length
    expect(indent(rendered[1])).toBeGreaterThan(indent(rendered[0]))
    expect(indent(rendered[2])).toBeGreaterThan(indent(rendered[1]))
  })

  it('marks the selected entry and only that one', () => {
    const rendered = outlineLines(entries, 1, { width: 40, unicode: true, colour: false })
    const marked = rendered.filter((l) => l.trimStart().startsWith('▸'))
    expect(marked).toHaveLength(1)
    expect(marked[0]).toContain('Tasks')
  })

  it('does not shift an entry sideways when it becomes selected', () => {
    // The marker lives in a fixed gutter. Folding it into the indent makes every
    // entry jump two columns as the selection passes over it.
    const where = (rendered: string[], i: number) => rendered[i].indexOf('Tasks')
    expect(where(outlineLines(entries, 1, { width: 40, unicode: true, colour: false }), 1)).toBe(
      where(outlineLines(entries, 0, { width: 40, unicode: true, colour: false }), 1)
    )
  })

  it('uses an ASCII marker without Unicode', () => {
    const rendered = outlineLines(entries, 0, { width: 40, unicode: false, colour: false })
    expect(rendered[0]).toContain('>')
    expect(rendered.join('')).not.toContain('▸')
  })

  it('never emits a line wider than the width', () => {
    const long = [{ id: 'x', level: 4, text: 'a heading far longer than the pane', line: 0 }]
    for (const line of outlineLines(long, 0, { width: 20, unicode: true, colour: false })) {
      expect(line.length).toBeLessThanOrEqual(20)
    }
  })

  it('says so when there is nothing to list', () => {
    const rendered = outlineLines([], 0, { width: 40, unicode: true, colour: false })
    expect(rendered.join(' ')).toContain('No headings')
  })
})
