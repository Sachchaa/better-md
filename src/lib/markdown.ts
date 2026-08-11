import { parseBlocks, type Block, type ListBlock } from '../../cli/blocks.js'

/* ------------------------------------------------------------------ *
 * Markdown <-> HTML conversion
 *
 * The rendered HTML is injected via innerHTML (editable preview) and
 * written into a print document, so all user-derived values that land in
 * markup MUST be escaped, and URLs MUST be scheme-checked to avoid XSS.
 * ------------------------------------------------------------------ */

/** Escape text destined for element content. Runs first on every line, so
 * later attribute escaping only needs to handle quotes. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escape a value for a double-quoted attribute. `<`, `>` and `&` are already
 * handled by esc() upstream; the remaining breakout char is the quote. */
function attrSafe(s: string): string {
  return s.replace(/"/g, '&quot;')
}

const DANGEROUS_SCHEME = /^\s*(javascript|vbscript):/i

/** Allow only safe link targets; block script-bearing and data: URLs. */
function safeHref(url: string): string {
  const t = url.trim()
  if (DANGEROUS_SCHEME.test(t) || /^\s*data:/i.test(t)) return '#'
  return attrSafe(t)
}

/** Allow image sources, permitting data:image/* but blocking script/other data. */
function safeImgSrc(url: string): string {
  const t = url.trim()
  if (DANGEROUS_SCHEME.test(t)) return '#'
  if (/^\s*data:/i.test(t) && !/^\s*data:image\//i.test(t)) return '#'
  return attrSafe(t)
}

export function inlineMd(s: string): string {
  s = esc(s)
  s = s.replace(
    /`([^`]+)`/g,
    '<code style="background:var(--code-bg);padding:.13em .42em;border-radius:5px;font:0.86em var(--mono)">$1</code>'
  )
  s = s.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_m, alt: string, url: string) =>
      `<img alt="${attrSafe(alt)}" src="${safeImgSrc(url)}" style="max-width:100%;border-radius:8px;margin:.3rem 0"/>`
  )
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text: string, url: string) =>
      `<a href="${safeHref(url)}" rel="noopener noreferrer nofollow" style="color:var(--accent);text-decoration:underline;text-underline-offset:2px">${text}</a>`
  )
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return s
}

const HEADING_SIZE: Record<number, string> = {
  1: '1.9em',
  2: '1.5em',
  3: '1.24em',
  4: '1.08em',
  5: '0.96em',
  6: '0.85em',
}

function renderList(node: ListBlock): string {
  const tag = node.ordered ? 'ol' : 'ul'
  // list-style is set explicitly because Tailwind's preflight resets it to
  // `none` on ul/ol, and this HTML is injected into a Tailwind-styled page.
  // Without it, bullets and numbers vanish — for two constructs the toolbar
  // has buttons for.
  const style = node.ordered
    ? 'margin:.6rem 0 .6rem 1.5rem;line-height:1.75;list-style:decimal'
    : 'margin:.6rem 0 .6rem 1.35rem;line-height:1.75;list-style:disc'
  return (
    `<${tag} style="${style}">` +
    node.items
      .map((item) => {
        // `disabled` is deliberate. The preview is contenteditable, and a live
        // checkbox would let a click change the DOM's checked *property* while
        // the attribute htmlToMd reads stays put — the box would flip on screen
        // and then snap back on the next render. Editing happens in the source.
        const body =
          item.checked === null
            ? inlineMd(item.text)
            : '<input type="checkbox" disabled' +
              (item.checked ? ' checked' : '') +
              ' style="margin-right:.5rem;vertical-align:middle"/>' +
              inlineMd(item.text)
        const liStyle = item.checked === null ? 'margin:.2rem 0' : 'margin:.2rem 0;list-style:none'
        const nested = item.children === null ? '' : renderList(item.children)
        return `<li style="${liStyle}">${body}${nested}</li>`
      })
      .join('') +
    `</${tag}>`
  )
}

function renderTable(block: Extract<Block, { kind: 'table' }>): string {
  const cellStyle = (n: number, extra: string): string => {
    const align = block.aligns[n]
    return (
      ` style="border:1px solid var(--border);padding:.4rem .6rem${extra}` +
      (align === null ? '' : `;text-align:${align}`) +
      '"'
    )
  }
  return (
    '<table style="margin:.95rem 0;border-collapse:collapse;width:100%;font-size:.95em">' +
    '<thead><tr>' +
    block.header
      .map((c, n) => `<th${cellStyle(n, ';background:var(--code-bg)')}>${inlineMd(c)}</th>`)
      .join('') +
    '</tr></thead><tbody>' +
    block.rows
      .map(
        (row) =>
          '<tr>' +
          // Ragged rows are padded rather than dropped: a short row in a plan
          // should still render, not vanish.
          block.aligns
            .map((_, n) => `<td${cellStyle(n, '')}>${inlineMd(row[n] ?? '')}</td>`)
            .join('') +
          '</tr>'
      )
      .join('') +
    '</tbody></table>'
  )
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return (
        `<h${block.level} style="margin:1.35rem 0 .55rem;font:600 ` +
        `${HEADING_SIZE[block.level]}/1.3 var(--sans);letter-spacing:-.01em">` +
        inlineMd(block.text) +
        `</h${block.level}>`
      )
    case 'paragraph':
      return '<p style="margin:.75rem 0;line-height:1.75">' + inlineMd(block.text) + '</p>'
    case 'code':
      return (
        '<pre style="margin:.95rem 0;padding:14px 16px;background:var(--code-bg);border:1px solid var(--border);border-radius:10px;overflow:auto"><code style="font:0.85em/1.65 var(--mono);white-space:pre">' +
        esc(block.lines.join('\n')) +
        '</code></pre>'
      )
    case 'quote':
      return (
        '<blockquote style="margin:.95rem 0;padding:.35rem 0 .35rem 1.05rem;border-left:3px solid var(--accent);color:var(--muted)">' +
        inlineMd(block.text) +
        '</blockquote>'
      )
    case 'rule':
      return '<hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--border)"/>'
    case 'table':
      return renderTable(block)
    case 'list':
      return renderList(block)
  }
}

export function mdToHtml(md: string): string {
  const html = parseBlocks(md).map(renderBlock).join('')
  return (
    html || '<p style="color:var(--faint)">Nothing to preview yet — start writing on the left.</p>'
  )
}

export function htmlToMd(root: HTMLElement): string {
  function kids(node: Node): string {
    let s = ''
    node.childNodes.forEach((c) => {
      s += ser(c)
    })
    return s
  }
  function liText(li: Node): string {
    return kids(li).replace(/\n+/g, ' ').trim()
  }
  /**
   * Serialise a list, recursing into nested ones.
   *
   * Children are indented by the parent's marker width — two columns under `- `,
   * three under `1. ` — because that is what makes the nesting survive a reparse
   * by this module and by every other Markdown tool that reads the file.
   */
  function listMd(el: HTMLElement, indent: string): string {
    const ordered = el.tagName.toLowerCase() === 'ol'
    let n = 1
    let out = ''
    for (const child of Array.from(el.children)) {
      if (child.tagName !== 'LI') continue
      const marker = ordered ? `${n++}. ` : '- '

      let own = ''
      let nested = ''
      let mark = ''
      child.childNodes.forEach((node) => {
        const tag = (node as HTMLElement).tagName
        if (tag === 'UL' || tag === 'OL') {
          nested += listMd(node as HTMLElement, indent + ' '.repeat(marker.length))
          return
        }
        if (tag === 'INPUT' && (node as HTMLElement).getAttribute('type') === 'checkbox') {
          // hasAttribute, not .checked: the box is disabled precisely so the
          // attribute stays the source of truth.
          mark = (node as HTMLElement).hasAttribute('checked') ? '[x] ' : '[ ] '
          return
        }
        own += ser(node)
      })

      out += indent + marker + mark + own.replace(/\n+/g, ' ').trim() + '\n' + nested
    }
    return out
  }

  function ser(node: Node): string {
    if (node.nodeType === 3) {
      return (node.nodeValue || '').replace(/\s+/g, ' ')
    }
    if (node.nodeType !== 1) return ''
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return '\n' + Array(+tag[1] + 1).join('#') + ' ' + kids(el).trim() + '\n\n'
      case 'strong':
      case 'b': {
        const b = kids(el)
        return b.trim() ? '**' + b + '**' : b
      }
      case 'em':
      case 'i': {
        const e = kids(el)
        return e.trim() ? '*' + e + '*' : e
      }
      case 'del':
      case 's':
      case 'strike':
        return '~~' + kids(el) + '~~'
      case 'code':
        return el.parentNode && (el.parentNode as HTMLElement).tagName === 'PRE'
          ? kids(el)
          : '`' + kids(el) + '`'
      case 'pre':
        return '\n```\n' + (el.textContent || '').replace(/\n+$/, '') + '\n```\n\n'
      case 'a':
        return '[' + kids(el) + '](' + (el.getAttribute('href') || '') + ')'
      case 'img':
        return '![' + (el.getAttribute('alt') || '') + '](' + (el.getAttribute('src') || '') + ')'
      case 'br':
        return '\n'
      case 'hr':
        return '\n---\n\n'
      case 'blockquote':
        return (
          '\n' +
          kids(el)
            .trim()
            .split('\n')
            .map((l) => '> ' + l)
            .join('\n') +
          '\n\n'
        )
      case 'table': {
        const trs = Array.from(el.querySelectorAll('tr'))
        if (trs.length === 0) return ''
        const cellsOf = (tr: Element): Element[] => Array.from(tr.children)
        // A pipe in a cell has to go back out escaped, or the next parse splits
        // the column that this one just round-tripped correctly.
        const row = (cells: Element[]): string =>
          '| ' + cells.map((c) => kids(c).trim().replace(/\|/g, '\\|')).join(' | ') + ' |'
        const head = cellsOf(trs[0])
        const delim = head.map((c) => {
          switch ((c as HTMLElement).style.textAlign) {
            case 'left':
              return ':--'
            case 'center':
              return ':-:'
            case 'right':
              return '--:'
            default:
              return '---'
          }
        })
        const out = [row(head), '| ' + delim.join(' | ') + ' |']
        for (const tr of trs.slice(1)) out.push(row(cellsOf(tr)))
        return '\n' + out.join('\n') + '\n\n'
      }
      case 'input':
        // Rendered by the ul case as the `[x]` marker; on its own it is not text.
        return ''
      case 'ul':
      case 'ol':
        return '\n' + listMd(el, '') + '\n'
      case 'li':
        return liText(el)
      case 'p':
      case 'div':
      case 'section': {
        const inner = kids(el)
        return inner.trim() ? inner.trim() + '\n\n' : ''
      }
      default:
        return kids(el)
    }
  }
  const out = kids(root)
  return out
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\s+$/, '')
}
