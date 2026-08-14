import { describe, expect, it } from 'vitest'
import { parseBlocks } from '../blocks.js'
import { PALETTE } from './ansi.js'
import { renderDocument } from './render.js'
import { displayWidth } from './wrap.js'

const plain = { width: 60, unicode: true, colour: false }
const render = (md: string, o = plain): string =>
  renderDocument(parseBlocks(md), o)
    .map((l) => l.text)
    .join('\n')

const coloured = { width: 60, unicode: true, colour: true }

describe('headings', () => {
  it('shows the text rather than its hashes', () => {
    const out = render('# Authentication Plan')
    expect(out).toContain('Authentication Plan')
    expect(out).not.toContain('#')
  })

  it('carries the brand colour and weight when the terminal has colour', () => {
    const out = render('# Authentication Plan', coloured)
    expect(out).toContain('\x1b[1m')
    expect(out).toContain(`38;5;${PALETTE.brand.ansi256}`)
  })

  it('drops the rule when colour can carry the hierarchy', () => {
    // A rule under every heading costs a line each and reads as an artifact next
    // to prose. Colour and weight say the same thing more quietly.
    const out = render('# Authentication Plan\n\n## Goal', coloured)
    expect(out).not.toContain('═')
    expect(out).not.toContain('───')
  })

  it('keeps the rule when there is no colour, because nothing else is left', () => {
    // `-t plan.md | less` and NO_COLOR emit no escapes at all, so the rule is the
    // only hierarchy signal available — it is a fallback, not decoration.
    expect(render('# Authentication Plan')).toContain('═')
    expect(render('## Goal')).toContain('─')
    expect(render('## Goal')).not.toContain('═')
  })

  it('distinguishes a third-level heading, which used to render as prose', () => {
    // `### game.js — the whole rulebook` was indistinguishable from a paragraph.
    const out = render('### Database', coloured)
    expect(out).toContain('Database')
    expect(out).toContain('\x1b[1m')
  })

  it('does not rule h3 and below, so deep documents stay readable', () => {
    const out = render('### Database')
    expect(out).toContain('Database')
    expect(out).not.toContain('─')
  })

  it('tags heading lines with an id so the outline can jump to them', () => {
    const lines = renderDocument(parseBlocks('# One\n\n## Two'), plain)
    expect(lines.find((l) => l.heading !== undefined)?.heading).toEqual({
      id: 'one',
      level: 1,
      text: 'One',
    })
    expect(lines.filter((l) => l.heading !== undefined)).toHaveLength(2)
  })
})

describe('task lists', () => {
  it('shows task state as a symbol, not brackets', () => {
    const out = render('- [x] done\n- [ ] todo')
    expect(out).toContain('✓ done')
    expect(out).toContain('○ todo')
    expect(out).not.toContain('[x]')
    expect(out).not.toContain('[ ]')
  })

  it('falls back to ASCII when the terminal is not UTF-8', () => {
    // A terminal that cannot render ✓ shows a replacement box, which is worse
    // than the brackets the source already had.
    const out = render('- [x] done\n- [ ] todo', { ...plain, unicode: false })
    expect(out).toContain('[x] done')
    expect(out).toContain('[ ] todo')
    expect(out).not.toContain('✓')
  })
})

describe('lists', () => {
  it('bullets a plain item without a checkbox', () => {
    const out = render('- plain')
    expect(out).toContain('plain')
    expect(out).not.toContain('○')
  })

  it('numbers an ordered list', () => {
    const out = render('1. one\n2. two')
    expect(out).toContain('1. one')
    expect(out).toContain('2. two')
  })

  it('indents nested items further than their parent', () => {
    const lines = renderDocument(parseBlocks('- a\n  - b'), plain).map((l) => l.text)
    const a = lines.find((l) => l.includes('a')) ?? ''
    const b = lines.find((l) => l.includes('b')) ?? ''
    expect(b.indexOf('b')).toBeGreaterThan(a.indexOf('a'))
  })

  it('restarts numbering inside a nested ordered list', () => {
    const out = render('- parent\n  1. one\n  2. two')
    expect(out).toContain('1. one')
    expect(out).toContain('2. two')
  })
})

describe('code blocks', () => {
  it('boxes a code block and keeps its content verbatim', () => {
    const out = render('```bash\nbetter-md --plan\n```')
    expect(out).toContain('bash')
    expect(out).toContain('better-md --plan')
    expect(out).toContain('┌')
    expect(out).toContain('└')
  })

  it('does not reflow code, it truncates', () => {
    // Wrapping code changes what it says. A long line is cut with a marker.
    const long = 'x'.repeat(200)
    const out = render('```\n' + long + '\n```', { ...plain, width: 40 })
    expect(out).toContain('…')
    for (const line of out.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(40)
  })

  it('uses ASCII borders without Unicode', () => {
    const out = render('```\nx\n```', { ...plain, unicode: false })
    expect(out).toContain('+')
    expect(out).not.toContain('┌')
  })
})

describe('tables', () => {
  it('draws borders when the columns fit', () => {
    const md = '| Component | Status |\n| --- | --- |\n| API | Complete |'
    const out = render(md)
    expect(out).toContain('┌')
    expect(out).toContain('Component')
    expect(out).toContain('Complete')
  })

  it('stacks a table that cannot fit instead of overflowing', () => {
    const md = '| Component | Status |\n| --- | --- |\n| API | Complete |'
    const narrow = render(md, { ...plain, width: 18 })
    expect(narrow).toContain('Component: API')
    expect(narrow).toContain('Status: Complete')
    expect(narrow).not.toContain('┌')
  })

  it('fills the pane instead of stopping at the content width', () => {
    // A table sized to its content leaves a ragged right edge beside prose that
    // runs the full width, which reads as broken rather than compact.
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    for (const line of renderDocument(parseBlocks(md), { ...plain, width: 50 })) {
      if (line.text.startsWith('┌') || line.text.startsWith('└')) {
        expect(displayWidth(line.text)).toBe(50)
      }
    }
  })

  it('shares the extra width out rather than padding one column', () => {
    const md = '| Short | A much longer heading here |\n| --- | --- |\n| x | y |'
    const lines = renderDocument(parseBlocks(md), { ...plain, width: 70 }).map((l) => l.text)
    const top = lines.find((l) => l.startsWith('┌')) ?? ''
    const [first, second] = top.slice(1, -1).split('┬')
    // The wider column stays wider; both grow.
    expect(second.length).toBeGreaterThan(first.length)
    expect(first.length).toBeGreaterThan('Short'.length + 2)
  })

  it('never emits a line wider than the width', () => {
    const md =
      '| Component | Status |\n| --- | --- |\n| A very long component name indeed | In progress |'
    for (const w of [20, 30, 60]) {
      for (const line of renderDocument(parseBlocks(md), { ...plain, width: w })) {
        expect(displayWidth(line.text), `width ${w}: ${line.text}`).toBeLessThanOrEqual(w)
      }
    }
  })
})

describe('inline code', () => {
  it('colours code rather than reversing it', () => {
    // Reverse video turned every identifier into a filled block. A plan mentioning
    // a dozen of them read like a redacted document.
    const out = render('call `bestMove(board)` first', coloured)
    expect(out).toContain(`38;5;${PALETTE.code.ansi256}`)
    expect(out).not.toContain('\x1b[7m')
  })

  it('uses a different hue from headings, so the two never compete', () => {
    const out = render('# Plan\n\nuse `bestMove`', coloured)
    expect(out).toContain(`38;5;${PALETTE.brand.ansi256}`)
    expect(out).toContain(`38;5;${PALETTE.code.ansi256}`)
  })

  it('still reads without colour, with the markers gone', () => {
    const out = render('call `bestMove(board)` first')
    expect(out).toContain('bestMove(board)')
    expect(out).not.toContain('`')
    expect(out).not.toContain('\x1b')
  })
})

describe('borders', () => {
  it('dims a table so the content dominates it', () => {
    // Asserted per line: checking the whole render only proves *some* border was
    // tinted, and the vertical bars are painted separately from the edges.
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    const lines = renderDocument(parseBlocks(md), coloured).map((l) => l.text)
    const border = `38;5;${PALETTE.border.ansi256}`
    for (const glyph of ['┌', '├', '└']) {
      const line = lines.find((l) => l.includes(glyph)) ?? ''
      expect(line, glyph).toContain(border)
    }
    // And the row bars too, so a cell never sits against an undimmed edge.
    expect(lines.find((l) => l.includes('A')) ?? '').toContain(border)
  })

  it('dims a code fence too', () => {
    expect(render('```js\nx\n```', coloured)).toContain(`38;5;${PALETTE.border.ansi256}`)
  })

  it('leaves the code itself unpainted, so a highlighter is never fought', () => {
    const out = render('```js\nconst x = 1\n```', coloured)
    expect(out).toContain('const x = 1')
  })
})

describe('inline syntax', () => {
  it('strips markers from prose', () => {
    // The whole point of the mode: read a document, not its source.
    const out = render('This is **important** and `code` and *maybe*.')
    expect(out).toContain('important')
    expect(out).toContain('code')
    expect(out).not.toContain('**')
    expect(out).not.toContain('`')
  })

  it('shows a link by its label, not its URL', () => {
    expect(render('see [the plan](https://example.com/very/long)')).toContain('the plan')
    expect(render('see [the plan](https://example.com/very/long)')).not.toContain('example.com')
  })

  it('shows an image by its alt text', () => {
    expect(render('![a diagram](x.png)')).toContain('a diagram')
  })
})

describe('raw HTML', () => {
  // READMEs centre their badges and screenshots with real HTML. A browser
  // renders it; a terminal would otherwise show the tags themselves.
  it('shows the text inside an HTML wrapper, not the wrapper', () => {
    const out = render('<p align="center">Read it like a document.</p>')
    expect(out).toContain('Read it like a document.')
    expect(out).not.toContain('<p')
    expect(out).not.toContain('align')
  })

  it('omits a block that is nothing but markup', () => {
    expect(renderDocument(parseBlocks('<img src="shot.png" width="900">'), plain)).toEqual([])
  })

  it('decodes the entities that survive tag stripping', () => {
    const out = render('<p>Website &nbsp;&bull;&nbsp; Install &amp; run</p>')
    expect(out).toContain('Install & run')
    expect(out).not.toContain('&nbsp;')
    expect(out).not.toContain('&amp;')
  })

  it('leaves entities alone inside code', () => {
    expect(render('escape it as `&amp;` in HTML')).toContain('&amp;')
  })

  it('keeps angle brackets that are inside code', () => {
    expect(render('wrap it in `<div>` first')).toContain('<div>')
    expect(render('```html\n<div>x</div>\n```')).toContain('<div>x</div>')
  })
})

describe('quotes and rules', () => {
  it('marks a quote down the left edge', () => {
    expect(render('> Postings stay sorted')).toContain('│')
  })

  it('draws a rule the full width', () => {
    const lines = renderDocument(parseBlocks('---'), { ...plain, width: 20 })
    expect(lines.some((l) => l.text.trim().length === 20)).toBe(true)
  })
})

describe('the document as a whole', () => {
  it('wraps long prose to the width', () => {
    const md = 'word '.repeat(80).trim()
    for (const line of renderDocument(parseBlocks(md), { ...plain, width: 40 })) {
      expect(displayWidth(line.text)).toBeLessThanOrEqual(40)
    }
  })

  it('renders nothing for an empty document', () => {
    expect(renderDocument(parseBlocks(''), plain)).toEqual([])
  })
})
