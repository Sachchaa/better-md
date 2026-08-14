/**
 * Render parsed blocks as lines of styled terminal text.
 *
 * The product rule this file exists to honour: the terminal shows a *document*,
 * not Markdown source. Nothing here should leave a `#`, `**` or `|` visible.
 *
 * Pure — no I/O, no process state — so the whole renderer is tested without a
 * terminal.
 */
import type { Align, Block, ListBlock } from '../blocks.js'
import { paint, PALETTE, style, type Colour, type ColourDepth } from './ansi.js'
import { displayWidth, truncate, wrap } from './wrap.js'

export interface Line {
  text: string
  /**
   * Present on a heading's own line, carrying everything a consumer needs.
   *
   * The outline and the reload anchor both read ids from here rather than
   * deriving their own: two id generators over the same document will
   * eventually disagree, and then a jump lands on the wrong section.
   *
   * `text` is the plain heading, without the inline markers or the styling in
   * `Line.text`, so a list of headings reads as a list of headings.
   */
  heading?: { id: string; level: number; text: string }
}

export interface RenderOptions {
  width: number
  unicode: boolean
  colour: boolean
  /**
   * How much colour the terminal can show. Defaults to 256, which every terminal
   * this mode targets has had for a decade; `colour: false` still wins outright.
   */
  depth?: ColourDepth
}

interface Glyphs {
  done: string
  todo: string
  bullet: string
  quote: string
  h1Rule: string
  h2Rule: string
  rule: string
  box: { tl: string; tr: string; bl: string; br: string; h: string; v: string; cross: string; tDown: string; tUp: string; tRight: string; tLeft: string }
}

const UNICODE: Glyphs = {
  done: '✓',
  todo: '○',
  bullet: '•',
  quote: '│',
  h1Rule: '═',
  h2Rule: '─',
  rule: '─',
  box: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', cross: '┼', tDown: '┬', tUp: '┴', tRight: '├', tLeft: '┤' },
}

const ASCII: Glyphs = {
  done: '[x]',
  todo: '[ ]',
  bullet: '-',
  quote: '|',
  h1Rule: '=',
  h2Rule: '-',
  rule: '-',
  box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', cross: '+', tDown: '+', tUp: '+', tRight: '+', tLeft: '+' },
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&bull;': '•',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
}

/**
 * Drop HTML tags and decode entities, keeping the text they wrap.
 *
 * Markdown files carry real HTML — `<p align="center">` around a tagline, an
 * `<img>` for a screenshot — which a browser renders and a terminal cannot. The
 * split keeps code spans intact: `` `<div>` `` is content, not markup.
 */
function unhtml(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith('`')
        ? part
        : part
            .replace(/<\/?[a-zA-Z][^>]*>/g, '')
            // After the tags, so `&lt;div&gt;` is text rather than a tag to
            // strip. One pass, so `&amp;lt;` decodes to `&lt;` and stops there.
            .replace(/&(?:nbsp|bull|mdash|ndash|hellip|quot|apos|#39|lt|gt|amp);/g, (m) => ENTITIES[m])
    )
    .join('')
}

/**
 * Turn inline Markdown into styled display text.
 *
 * A display transform, not an escaping one: nothing here is injected into
 * markup, so there is no XSS surface. Order matters — images before links, or
 * `![alt](src)` loses its bang and becomes a link.
 */
function plain(text: string): string {
  return inline(text, { width: 0, unicode: false, colour: false })
}

/**
 * How much colour to use.
 *
 * Derived from the existing `colour` flag rather than a new option, so a pipe and
 * NO_COLOR keep emitting no escapes at all. A terminal that reports only the basic
 * sixteen still gets colour, just coarser.
 */
function depthOf(o: RenderOptions): ColourDepth {
  return o.colour ? (o.depth ?? 'ansi256') : 'none'
}

function tint(text: string, colour: Colour, o: RenderOptions): string {
  return paint(text, colour, depthOf(o))
}

function inline(text: string, o: RenderOptions): string {
  const on = { enabled: o.colour }
  return unhtml(text)
    .replace(/!\[([^\]]*)\]\([^)\s]*\)/g, (_m, alt: string) => style(alt, 'italic', on))
    .replace(/\[([^\]]+)\]\([^)\s]*\)/g, (_m, label: string) =>
      tint(style(label, 'underline', on), PALETTE.link, o)
    )
    // A colour rather than reverse video: a plan mentioning a dozen identifiers
    // turned into a page of filled blocks, which read as redaction.
    .replace(/`([^`]+)`/g, (_m, code: string) => tint(code, PALETTE.code, o))
    .replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => style(t, 'bold', on))
    .replace(/__([^_]+)__/g, (_m, t: string) => style(t, 'bold', on))
    .replace(/~~([^~]+)~~/g, (_m, t: string) => style(t, 'dim', on))
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre: string, t: string) => pre + style(t, 'italic', on))
    .replace(/(^|[^_\w])_([^_\n]+)_/g, (_m, pre: string, t: string) => pre + style(t, 'italic', on))
}

function headingId(text: string, seen: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  const n = seen.get(base) ?? 0
  seen.set(base, n + 1)
  // Two "## Tasks" headings in one plan is common; an id has to stay unique or
  // the outline jumps to the wrong one.
  return n === 0 ? base : `${base}-${n}`
}

function renderList(
  list: ListBlock,
  o: RenderOptions,
  g: Glyphs,
  depth: number,
  out: Line[]
): void {
  const indent = '  '.repeat(depth)
  list.items.forEach((item, index) => {
    const marker =
      item.checked === null
        ? list.ordered
          ? `${index + 1}. `
          : `${g.bullet} `
        : `${item.checked ? g.done : g.todo} `
    const hang = ' '.repeat(displayWidth(marker))
    const body = wrap(inline(item.text, o), Math.max(1, o.width - displayWidth(indent + marker)))
    body.forEach((chunk, n) => {
      out.push({ text: indent + (n === 0 ? marker : hang) + chunk })
    })
    if (item.children !== null) renderList(item.children, o, g, depth + 1, out)
  })
}

function renderCode(
  block: Extract<Block, { kind: 'code' }>,
  o: RenderOptions,
  g: Glyphs,
  out: Line[]
): void {
  const label = block.language === '' ? '' : ` ${block.language} `
  const head = `${g.box.tl}${g.box.h}${label}`
  out.push({
    text: tint(head + g.box.h.repeat(Math.max(0, o.width - displayWidth(head))), PALETTE.border, o),
  })
  for (const raw of block.lines) {
    // Truncate, never wrap: reflowing code changes what it says.
    // The border is tinted, the code is not: painting code would fight anything
    // the reader's own highlighter does with it.
    out.push({
      text: `${tint(g.box.v, PALETTE.border, o)} ${truncate(raw, Math.max(1, o.width - 2))}`,
    })
  }
  out.push({ text: tint(g.box.bl + g.box.h.repeat(Math.max(0, o.width - 1)), PALETTE.border, o) })
  out.push({ text: '' })
}

function alignCell(text: string, width: number, align: Align): string {
  const pad = Math.max(0, width - displayWidth(text))
  if (align === 'right') return ' '.repeat(pad) + text
  if (align === 'center') {
    const left = Math.floor(pad / 2)
    return ' '.repeat(left) + text + ' '.repeat(pad - left)
  }
  return text + ' '.repeat(pad)
}

function renderTable(
  block: Extract<Block, { kind: 'table' }>,
  o: RenderOptions,
  g: Glyphs,
  out: Line[]
): void {
  const columns = block.header.length
  const widths = block.header.map((h, n) =>
    Math.max(displayWidth(h), ...block.rows.map((r) => displayWidth(r[n] ?? '')))
  )
  // Borders and padding cost 3 columns per column plus one closing edge.
  const needed = widths.reduce((a, b) => a + b + 3, 1)

  // Spread any slack across the columns so the table meets the right edge. A
  // content-width table beside full-width prose reads as broken, not compact.
  // Proportional, so a column that was wider stays wider.
  if (needed < o.width) {
    let slack = o.width - needed
    const total = widths.reduce((a, b) => a + b, 0) || 1
    const shares = widths.map((w) => Math.floor((slack * w) / total))
    shares.forEach((share, n) => {
      widths[n] += share
      slack -= share
    })
    // Whatever rounding left over goes to the widest column, where it shows least.
    const widest = widths.indexOf(Math.max(...widths))
    widths[widest] += slack
  }

  if (needed > o.width) {
    // Stacked rather than overflowing: a table wider than the pane would push
    // every column to its right off screen.
    block.rows.forEach((row) => {
      block.header.forEach((h, n) => {
        const label = `${h}: `
        wrap(inline(row[n] ?? '', o), Math.max(1, o.width - displayWidth(label))).forEach(
          (chunk, i) => out.push({ text: (i === 0 ? label : ' '.repeat(displayWidth(label))) + chunk })
        )
      })
      out.push({ text: '' })
    })
    return
  }

  const edge = (left: string, mid: string, right: string): string =>
    tint(left + widths.map((w) => g.box.h.repeat(w + 2)).join(mid) + right, PALETTE.border, o)
  const bar = tint(g.box.v, PALETTE.border, o)
  const row = (cells: string[]): string =>
    bar + cells.map((c, n) => ` ${alignCell(c, widths[n], block.aligns[n])} `).join(bar) + bar

  out.push({ text: edge(g.box.tl, g.box.tDown, g.box.tr) })
  out.push({ text: row(block.header.map((h) => inline(h, o))) })
  out.push({ text: edge(g.box.tRight, g.box.cross, g.box.tLeft) })
  for (const r of block.rows) {
    out.push({
      text: row(Array.from({ length: columns }, (_, n) => inline(r[n] ?? '', o))),
    })
  }
  out.push({ text: edge(g.box.bl, g.box.tUp, g.box.br) })
  out.push({ text: '' })
}

export function renderDocument(blocks: Block[], o: RenderOptions): Line[] {
  const g = o.unicode ? UNICODE : ASCII
  const out: Line[] = []
  const seen = new Map<string, number>()

  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const text = inline(block.text, o)
        // Levels 1-2 take the brand colour, level 3+ takes weight alone, so three
        // tiers are visible. Before this, `###` rendered as plain prose.
        const painted =
          block.level <= 2 ? tint(text, PALETTE.brand, o) : text
        out.push({
          text: style(painted, 'bold', { enabled: o.colour }),
          heading: {
            id: headingId(block.text, seen),
            level: block.level,
            // Plain: the styled form lives in `text`, and a heading list wants
            // the words rather than the escape codes around them.
            text: plain(block.text),
          },
        })
        // The rule is a fallback, not decoration: with colour it costs a line per
        // heading and reads as an artifact, but without colour it is the only
        // hierarchy signal left — `-t plan.md | less` emits no escapes at all.
        if (!o.colour && (block.level === 1 || block.level === 2)) {
          const glyph = block.level === 1 ? g.h1Rule : g.h2Rule
          out.push({ text: glyph.repeat(Math.min(o.width, Math.max(4, displayWidth(text)))) })
        }
        out.push({ text: '' })
        break
      }
      case 'paragraph': {
        const text = inline(block.text, o)
        // A paragraph holding only markup — a centred `<img>`, a row of badge
        // links — has nothing left to show. A blank gap is better than an
        // empty line where a screenshot used to be.
        if (text.trim() === '') break
        for (const chunk of wrap(text, o.width)) out.push({ text: chunk })
        out.push({ text: '' })
        break
      }
      case 'quote':
        for (const chunk of wrap(inline(block.text, o), Math.max(1, o.width - 2))) {
          out.push({
            text: `${tint(g.quote, PALETTE.border, o)} ${tint(chunk, PALETTE.muted, o)}`,
          })
        }
        out.push({ text: '' })
        break
      case 'rule':
        out.push({ text: tint(g.rule.repeat(o.width), PALETTE.border, o) })
        out.push({ text: '' })
        break
      case 'code':
        renderCode(block, o, g, out)
        break
      case 'table':
        renderTable(block, o, g, out)
        break
      case 'list':
        renderList(block, o, g, 0, out)
        out.push({ text: '' })
        break
    }
  }

  // A document ends with content, not with the blank line that separated it from
  // whatever would have come next.
  while (out.length > 0 && out[out.length - 1].text === '') out.pop()
  return out
}
