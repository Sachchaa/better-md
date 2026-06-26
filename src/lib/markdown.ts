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

export function mdToHtml(md: string): string {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n')
  let html = ''
  let i = 0
  const Hsize: Record<number, string> = {
    1: '1.9em',
    2: '1.5em',
    3: '1.24em',
    4: '1.08em',
    5: '0.96em',
    6: '0.85em',
  }
  function para(buf: string[]): void {
    if (buf.length) {
      html += '<p style="margin:.75rem 0;line-height:1.75">' + inlineMd(buf.join(' ')) + '</p>'
    }
  }
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^([ \t]*)```/)
    if (fence) {
      // Fences may be indented (e.g. nested under a list item). Capture the
      // opening indent and strip up to that much from each content line.
      const indent = fence[1].length
      i++
      const code: string[] = []
      while (i < lines.length && !/^[ \t]*```/.test(lines[i])) {
        code.push(lines[i].replace(/^[ \t]+/, (m) => m.slice(indent)))
        i++
      }
      i++
      html +=
        '<pre style="margin:.95rem 0;padding:14px 16px;background:var(--code-bg);border:1px solid var(--border);border-radius:10px;overflow:auto"><code style="font:0.85em/1.65 var(--mono);white-space:pre">' +
        esc(code.join('\n')) +
        '</code></pre>'
      continue
    }
    if (/^\s*$/.test(line)) {
      i++
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const n = h[1].length
      html +=
        '<h' +
        n +
        ' style="margin:1.35rem 0 .55rem;font:600 ' +
        Hsize[n] +
        '/1.3 var(--sans);letter-spacing:-.01em">' +
        inlineMd(h[2]) +
        '</h' +
        n +
        '>'
      i++
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html += '<hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--border)"/>'
      i++
      continue
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      html +=
        '<blockquote style="margin:.95rem 0;padding:.35rem 0 .35rem 1.05rem;border-left:3px solid var(--accent);color:var(--muted)">' +
        inlineMd(q.join(' ')) +
        '</blockquote>'
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const ui: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        ui.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      html +=
        '<ul style="margin:.6rem 0 .6rem 1.35rem;line-height:1.75">' +
        ui.map((t) => '<li style="margin:.2rem 0">' + inlineMd(t) + '</li>').join('') +
        '</ul>'
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const oi: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        oi.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      html +=
        '<ol style="margin:.6rem 0 .6rem 1.5rem;line-height:1.75">' +
        oi.map((t) => '<li style="margin:.2rem 0">' + inlineMd(t) + '</li>').join('') +
        '</ol>'
      continue
    }
    const buf: string[] = []
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^[ \t]*```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    para(buf)
  }
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
      case 'ul': {
        let s = '\n'
        el.childNodes.forEach((li) => {
          if ((li as HTMLElement).tagName === 'LI') s += '- ' + liText(li) + '\n'
        })
        return s + '\n'
      }
      case 'ol': {
        let s2 = '\n'
        let n = 1
        el.childNodes.forEach((li) => {
          if ((li as HTMLElement).tagName === 'LI') s2 += n++ + '. ' + liText(li) + '\n'
        })
        return s2 + '\n'
      }
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
