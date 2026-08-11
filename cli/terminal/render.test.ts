import { describe, expect, it } from 'vitest'
import { parseBlocks } from '../blocks.js'
import { renderDocument } from './render.js'
import { displayWidth } from './wrap.js'

const plain = { width: 60, unicode: true, colour: false }
const render = (md: string, o = plain): string =>
  renderDocument(parseBlocks(md), o)
    .map((l) => l.text)
    .join('\n')

describe('headings', () => {
  it('underlines a heading rather than printing its hashes', () => {
    const out = render('# Authentication Plan')
    expect(out).toContain('Authentication Plan')
    expect(out).not.toContain('#')
    expect(out).toContain('═')
  })

  it('uses a lighter rule for h2 than h1', () => {
    expect(render('## Goal')).toContain('─')
    expect(render('## Goal')).not.toContain('═')
  })

  it('does not rule h3 and below, so deep documents stay readable', () => {
    const out = render('### Database')
    expect(out).toContain('Database')
    expect(out).not.toContain('─')
  })

  it('tags heading lines with an id so the outline can jump to them', () => {
    const lines = renderDocument(parseBlocks('# One\n\n## Two'), plain)
    expect(lines.filter((l) => l.headingId !== undefined)).toHaveLength(2)
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
