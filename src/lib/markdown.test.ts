import { describe, it, expect } from 'vitest'
import { esc, inlineMd, mdToHtml, htmlToMd } from './markdown'

describe('esc', () => {
  it('escapes HTML metacharacters', () => {
    expect(esc('<b> & </b>')).toBe('&lt;b&gt; &amp; &lt;/b&gt;')
  })
})

describe('inlineMd', () => {
  it('renders bold, italic, code, strike', () => {
    expect(inlineMd('**a**')).toContain('<strong>a</strong>')
    expect(inlineMd('*a*')).toContain('<em>a</em>')
    expect(inlineMd('`a`')).toContain('<code')
    expect(inlineMd('~~a~~')).toContain('<del>a</del>')
  })

  it('escapes raw HTML in text', () => {
    expect(inlineMd('<script>')).not.toContain('<script>')
    expect(inlineMd('<script>')).toContain('&lt;script&gt;')
  })

  it('blocks javascript: links (XSS)', () => {
    const out = inlineMd('[x](javascript:alert(1))')
    expect(out).not.toMatch(/href="javascript:/i)
    expect(out).toContain('href="#"')
  })

  it('blocks data: links but allows data:image sources', () => {
    expect(inlineMd('[x](data:text/html,<script>)')).toContain('href="#"')
    expect(inlineMd('![x](data:image/png;base64,AAAA)')).toContain(
      'src="data:image/png;base64,AAAA"'
    )
    expect(inlineMd('![x](data:text/html,evil)')).toContain('src="#"')
  })

  it('prevents attribute breakout via quotes in url/alt', () => {
    // A quote in the URL must be escaped, never closing the attribute early.
    const linkOut = inlineMd('[x](https://a"onmouseover=alert(1))')
    expect(linkOut).toContain('&quot;')
    expect(linkOut).not.toMatch(/href="https:\/\/a"/)

    const imgOut = inlineMd('![a"onerror=alert(1)](https://x)')
    expect(imgOut).toContain('&quot;')
    expect(imgOut).not.toMatch(/alt="a"/)
  })

  it('adds rel safety attributes to links', () => {
    expect(inlineMd('[x](https://example.com)')).toContain('rel="noopener noreferrer nofollow"')
  })
})

describe('mdToHtml', () => {
  it('renders headings with the right level', () => {
    expect(mdToHtml('# Title')).toMatch(/<h1[^>]*>Title<\/h1>/)
    expect(mdToHtml('### Sub')).toMatch(/<h3[^>]*>Sub<\/h3>/)
  })

  it('renders unordered and ordered lists', () => {
    expect(mdToHtml('- a\n- b')).toMatch(/<ul[^>]*>.*<li[^>]*>a<\/li>.*<li[^>]*>b<\/li>.*<\/ul>/)
    expect(mdToHtml('1. a\n2. b')).toMatch(/<ol[^>]*>.*<li[^>]*>a<\/li>.*<li[^>]*>b<\/li>.*<\/ol>/)
  })

  it('renders fenced code blocks and escapes their contents', () => {
    const out = mdToHtml('```\n<b>x</b>\n```')
    expect(out).toContain('<pre')
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  it('renders indented (list-nested) fenced code blocks without stray backticks', () => {
    const md = ['- `typedefs.graphql`: add', '  ```graphql', '  input X { id: ID! }', '  ```'].join(
      '\n'
    )
    const out = mdToHtml(md)
    expect(out).toContain('<pre')
    // content is dedented and escaped, not left in a paragraph
    expect(out).toContain('input X { id: ID! }')
    // the bug symptom: leftover double backticks must not appear
    expect(out).not.toContain('``')
  })

  it('renders blockquotes and horizontal rules', () => {
    expect(mdToHtml('> quote')).toContain('<blockquote')
    expect(mdToHtml('---')).toContain('<hr')
  })

  it('shows a placeholder for empty input', () => {
    expect(mdToHtml('')).toContain('Nothing to preview yet')
  })
})

describe('htmlToMd', () => {
  function fromHtml(html: string): string {
    const div = document.createElement('div')
    div.innerHTML = html
    return htmlToMd(div)
  }

  it('serialises inline marks', () => {
    expect(fromHtml('<p><strong>hi</strong></p>')).toBe('**hi**')
    expect(fromHtml('<p><em>hi</em></p>')).toBe('*hi*')
    expect(fromHtml('<p><del>hi</del></p>')).toBe('~~hi~~')
  })

  it('serialises headings and lists', () => {
    expect(fromHtml('<h2>Title</h2>')).toBe('## Title')
    expect(fromHtml('<ul><li>a</li><li>b</li></ul>')).toBe('- a\n- b')
    expect(fromHtml('<ol><li>a</li><li>b</li></ol>')).toBe('1. a\n2. b')
  })

  it('round-trips a small document', () => {
    const md = '# Title\n\nSome **bold** and *italic* text.\n\n- one\n- two'
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    expect(htmlToMd(div)).toBe(md)
  })
})
