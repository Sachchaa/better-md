/* ------------------------------------------------------------------ *
 * Markdown block parser — shared by both renderers.
 *
 * `mdToHtml` used to scan and emit HTML in one pass, which left a second
 * renderer nothing to consume. This splits the scan out: parseBlocks returns
 * typed nodes, and each renderer turns those into its own output.
 *
 * Inline syntax is NOT parsed here. Blocks carry raw inline text, because the
 * two renderers need opposite things from it: the HTML one must escape (it is
 * injected via innerHTML), the terminal one must style. Keeping inline handling
 * out of this module keeps the XSS-critical escaping entirely inside the HTML
 * renderer, where it can be reasoned about.
 *
 * Lives under cli/ rather than src/lib/ because tsconfig.cli sets
 * `rootDir: ./cli` and so cannot import from src/; the reverse works.
 * ------------------------------------------------------------------ */

export type Align = 'left' | 'center' | 'right' | null

export interface ListItem {
  /** Inline text, with any `[x]`/`[ ]` marker stripped. */
  text: string
  /** null when the item is not a task item. */
  checked: boolean | null
  children: ListBlock | null
}

export interface ListBlock {
  kind: 'list'
  ordered: boolean
  items: ListItem[]
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; header: string[]; aligns: Align[]; rows: string[][] }
  | ListBlock

/**
 * Split a table row on unescaped pipes.
 *
 * `\|` is content, not a separator — without that a cell mentioning a pipe
 * silently gains a column and shifts every value after it.
 */
export function splitRow(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (line[i] === '|') {
      cells.push(cur)
      cur = ''
      continue
    }
    cur += line[i]
  }
  cells.push(cur)
  // Outer pipes are optional decoration, so the empty cells they create are not
  // columns. Only the outermost ones — `| | b |` keeps its empty first column.
  if (cells.length > 1 && cells[0].trim() === '') cells.shift()
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((c) => c.trim())
}

/**
 * Read a delimiter row (`| :-- | :-: | --: |`) into per-column alignments, or
 * null when the line is not one.
 *
 * The delimiter row is what separates a table from prose that happens to contain
 * pipes, so this doubles as the detector.
 */
function delimiterAligns(line: string): Align[] | null {
  if (!line.includes('-') || !line.includes('|')) return null
  const cells = splitRow(line)
  if (cells.length === 0) return null
  const aligns: Align[] = []
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null)
  }
  return aligns
}

/** A table begins with a header row followed by a matching delimiter row. */
function tableAt(lines: string[], i: number): Align[] | null {
  if (i + 1 >= lines.length || !lines[i].includes('|')) return null
  const aligns = delimiterAligns(lines[i + 1])
  if (aligns === null) return null
  return splitRow(lines[i]).length === aligns.length ? aligns : null
}

/** One list line: `- text`, `* text`, `+ text` or `1. text`, with its indent. */
const LIST_ITEM = /^([ \t]*)([-*+]|\d+\.)[ \t]+(.*)$/

/** A fence opener or closer, at any indent — fences nest inside list items. */
const FENCE = /^[ \t]*```/

/** Indent in columns. A tab counts as four, the usual Markdown convention. */
function indentWidth(ws: string): number {
  let n = 0
  for (const ch of ws) n += ch === '\t' ? 4 : 1
  return n
}

/**
 * Turn a run of list lines into a tree, using relative indentation.
 *
 * Relative rather than a fixed step, because `- ` and `1. ` are different widths
 * and real documents mix two- and three-space children accordingly. Anything
 * indented further than the current level starts a nested list; anything less
 * closes levels until it fits.
 */
function buildList(entries: Array<{ indent: number; ordered: boolean; text: string }>): ListBlock {
  const root: ListBlock = { kind: 'list', ordered: entries[0].ordered, items: [] }
  const stack = [{ indent: entries[0].indent, node: root }]

  for (const entry of entries) {
    while (stack.length > 1 && entry.indent < stack[stack.length - 1].indent) stack.pop()
    let top = stack[stack.length - 1]

    if (entry.indent > top.indent) {
      const parent = top.node.items[top.node.items.length - 1]
      // A deeper line with no parent item above it cannot nest into anything, so
      // it joins the current level rather than being dropped.
      if (parent !== undefined) {
        const child: ListBlock = { kind: 'list', ordered: entry.ordered, items: [] }
        parent.children = child
        stack.push({ indent: entry.indent, node: child })
        top = stack[stack.length - 1]
      }
    }
    const task = /^\[([ xX])\]\s+(.*)$/.exec(entry.text)
    top.node.items.push({
      text: task === null ? entry.text : task[2],
      checked: task === null ? null : task[1] !== ' ',
      children: null,
    })
  }
  return root
}

export function parseBlocks(md: string): Block[] {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    const fence = line.match(/^([ \t]*)```/)
    if (fence) {
      // Fences may be indented (e.g. nested under a list item). Capture the
      // opening indent and strip up to that much from each content line.
      const indent = fence[1].length
      const language = line.slice(fence[0].length).trim()
      i++
      const code: string[] = []
      while (i < lines.length && !/^[ \t]*```/.test(lines[i])) {
        code.push(lines[i].replace(/^[ \t]+/, (m) => m.slice(indent)))
        i++
      }
      i++
      blocks.push({ kind: 'code', language, lines: code })
      continue
    }

    if (/^\s*$/.test(line)) {
      i++
      continue
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      blocks.push({
        kind: 'heading',
        level: h[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: h[2],
      })
      i++
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }

    if (/^>\s?/.test(line)) {
      const q: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ kind: 'quote', text: q.join(' ') })
      continue
    }

    const aligns = tableAt(lines, i)
    if (aligns !== null) {
      const header = splitRow(lines[i])
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]))
        i++
      }
      blocks.push({ kind: 'table', header, aligns, rows })
      continue
    }

    if (LIST_ITEM.test(line)) {
      const entries: Array<{ indent: number; ordered: boolean; text: string }> = []
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i])
        if (m !== null) {
          entries.push({
            indent: indentWidth(m[1]),
            ordered: /\d/.test(m[2]),
            text: m[3],
          })
          i++
          continue
        }

        // An indented, non-blank line belongs to the item above it. Ending the
        // list here instead made the rest of a wrapped bullet a stray paragraph —
        // and, worse, split an ordered list in two so the numbering restarted.
        //
        // Indentation is the signal, and only indentation: a flush-left line is
        // left as its own paragraph. Swallowing that would be the more damaging
        // error, silently eating a paragraph the author had separated.
        // A fence is structure, not prose, even indented under an item: swallowing
        // it as text left the backticks in the paragraph and lost the code block.
        if (FENCE.test(lines[i])) break

        // One rule: indented past the item's own marker continues it. That covers
        // the flush-left case too, since indent 0 is never past anything.
        const last = entries[entries.length - 1]
        const continuation = /^([ \t]*)(\S.*)$/.exec(lines[i])
        if (continuation === null || indentWidth(continuation[1]) <= last.indent) break
        last.text = `${last.text} ${continuation[2]}`
        i++
      }
      blocks.push(buildList(entries))
      continue
    }

    const buf: string[] = []
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^[ \t]*```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      // Without this the paragraph buffer swallows a table that follows prose
      // directly, header row and all.
      tableAt(lines, i) === null
    ) {
      buf.push(lines[i])
      i++
    }
    if (buf.length) blocks.push({ kind: 'paragraph', text: buf.join(' ') })
  }

  return blocks
}
