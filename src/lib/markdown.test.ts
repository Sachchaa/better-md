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

  it('records the fence language, so editing the preview cannot lose it', () => {
    // Every keystroke in the preview rewrites the whole document through
    // htmlToMd. With the language nowhere in the HTML, a stray edit in a
    // paragraph silently stripped ```ts off every code block in the file.
    const out = mdToHtml('```ts\nconst x = 1\n```')
    expect(out).toContain('language-ts')
  })

  it('escapes a language that tries to break out of the attribute', () => {
    // The language is whatever followed the backticks, so it is user input on
    // its way into an attribute.
    const out = mdToHtml('```" onmouseover="alert(1)\nx\n```')
    expect(out).not.toContain('onmouseover="alert(1)"')
    expect(out).toContain('&quot;')
  })

  it('leaves a fence with no language alone', () => {
    expect(mdToHtml('```\nx\n```')).not.toContain('language-')
  })

  it('puts only the language token in the class', () => {
    // An info string can carry more than the language. All of it in one class
    // attribute silently becomes several classes, so the convention breaks and
    // a highlighter looking for `language-js` never finds it.
    const out = mdToHtml('```js title="app.js"\nx\n```')
    expect(out).toContain('class="language-js"')
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

  // Regression: the inline styles set margin and line-height but not list-style,
  // and Tailwind's preflight resets ul/ol to `list-style: none`. The result was
  // bullets and numbers silently missing from every rendered list — including the
  // two the toolbar has buttons for. Asserting the declaration is present is the
  // only check available here, since jsdom computes no styles from preflight.
  it('keeps list markers visible against a CSS reset', () => {
    expect(mdToHtml('- one\n- two')).toContain('list-style:disc')
    expect(mdToHtml('1. one\n2. two')).toContain('list-style:decimal')
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

describe('tables', () => {
  const simple = ['| Name | Role |', '| --- | --- |', '| Ada | Analyst |'].join('\n')

  it('renders a pipe table as a real table', () => {
    const html = mdToHtml(simple)
    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).toContain('Name')
    expect(html).toContain('<td')
    expect(html).toContain('Ada')
  })

  it('requires a delimiter row, so prose containing pipes stays a paragraph', () => {
    // `a | b` in ordinary text must not become a table, or writing about pipes
    // silently mangles the document.
    const html = mdToHtml('choose a | b as the separator')
    expect(html).not.toContain('<table')
    expect(html).toContain('<p')
  })

  it('applies column alignment from the delimiter row', () => {
    const html = mdToHtml(['| L | C | R |', '| :-- | :-: | --: |', '| 1 | 2 | 3 |'].join('\n'))
    expect(html).toContain('text-align:left')
    expect(html).toContain('text-align:center')
    expect(html).toContain('text-align:right')
  })

  it('renders inline markdown inside cells', () => {
    const html = mdToHtml(['| a |', '| --- |', '| **bold** |'].join('\n'))
    expect(html).toContain('<strong>bold</strong>')
  })

  it('escapes cell content rather than trusting it', () => {
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(['| a |', '| --- |', '| <img src=x onerror=alert(1)> |'].join('\n'))

    // Asserted against the parsed DOM, not the string. The escaped form still
    // *contains* "onerror=alert" as literal text, which is exactly the safe
    // outcome — a substring check would fail on correct behaviour. What matters
    // is that no element was created from it.
    expect(div.querySelector('img')).toBeNull()
    expect(div.querySelector('td')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('honours an escaped pipe inside a cell', () => {
    const html = mdToHtml(['| a | b |', '| --- | --- |', String.raw`| x \| y | z |`].join('\n'))
    // Two columns, not three: the escaped pipe is content.
    expect(html).toContain('x | y')
    expect((html.match(/<td/g) ?? []).length).toBe(2)
  })

  it('serialises a table back to pipes', () => {
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(simple)
    expect(htmlToMd(div)).toBe(simple)
  })

  it('round-trips alignment', () => {
    const md = ['| L | C | R |', '| :-- | :-: | --: |', '| 1 | 2 | 3 |'].join('\n')
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    expect(htmlToMd(div)).toBe(md)
  })

  it('round-trips a pipe inside a cell without splitting the column', () => {
    const md = ['| a | b |', '| --- | --- |', String.raw`| x \| y | z |`].join('\n')
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    expect(htmlToMd(div)).toBe(md)
  })
})

describe('task lists', () => {
  it('renders checked and unchecked boxes', () => {
    const html = mdToHtml('- [x] done\n- [ ] todo')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked')
    // The literal brackets must be gone, not merely accompanied by a box.
    expect(html).not.toContain('[x]')
    expect(html).not.toContain('[ ]')
  })

  it('leaves an ordinary list item alone', () => {
    const html = mdToHtml('- plain')
    expect(html).not.toContain('type="checkbox"')
    expect(html).toContain('list-style:disc')
  })

  it('renders inline markdown in the task text', () => {
    expect(mdToHtml('- [ ] ship **it**')).toContain('<strong>it</strong>')
  })

  it('round-trips checked and unchecked items', () => {
    const md = '- [x] done\n- [ ] todo'
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    expect(htmlToMd(div)).toBe(md)
  })

  it('does not turn a plain list into a task list on the way back', () => {
    const md = '- one\n- two'
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    expect(htmlToMd(div)).toBe(md)
  })
})

describe('nested lists', () => {
  /** Render, then serialise straight back. */
  function roundTrip(md: string): string {
    const div = document.createElement('div')
    div.innerHTML = mdToHtml(md)
    return htmlToMd(div)
  }

  it('nests a deeper item inside its parent', () => {
    const html = mdToHtml('- a\n  - b')
    // The child belongs inside the parent's <li>, not as a sibling of it.
    expect(html).toMatch(/<li[^>]*>a<ul[^>]*>.*b.*<\/ul><\/li>/)
  })

  it('keeps a flat list flat', () => {
    const html = mdToHtml('- a\n- b')
    expect(html).not.toMatch(/<ul[^>]*>[\s\S]*<ul/)
  })

  it('handles three levels', () => {
    const html = mdToHtml('- a\n  - b\n    - c')
    expect((html.match(/<ul/g) ?? []).length).toBe(3)
  })

  it('returns to the outer level after a nested block', () => {
    const html = mdToHtml('- a\n  - b\n- c')
    expect((html.match(/<ul/g) ?? []).length).toBe(2)
    // `c` is a sibling of `a`, so the outer list has two items at top level.
    const outer = /<ul[^>]*>([\s\S]*)<\/ul>/.exec(html)?.[1] ?? ''
    expect(outer.split('<li').length - 1).toBeGreaterThanOrEqual(3)
  })

  it('nests an ordered list inside an unordered one', () => {
    const html = mdToHtml('- a\n  1. one\n  2. two')
    expect(html).toContain('<ol')
    expect(html).toMatch(/<li[^>]*>a<ol/)
  })

  it('nests a task list', () => {
    const html = mdToHtml('- parent\n  - [x] done')
    expect(html).toContain('type="checkbox"')
    expect(html).toMatch(/<li[^>]*>parent<ul/)
  })

  it('treats a tab as indentation', () => {
    expect(mdToHtml('- a\n\t- b')).toMatch(/<li[^>]*>a<ul/)
  })

  it('round-trips two levels', () => {
    expect(roundTrip('- a\n  - b')).toBe('- a\n  - b')
  })

  it('round-trips three levels and a return to the top', () => {
    const md = '- a\n  - b\n    - c\n- d'
    expect(roundTrip(md)).toBe(md)
  })

  it('round-trips an ordered list nested in a bullet', () => {
    const md = '- a\n  1. one\n  2. two'
    expect(roundTrip(md)).toBe(md)
  })

  it('round-trips a bullet nested in an ordered list', () => {
    // The child indents past `1. `, which is three characters wide, not two.
    const md = '1. one\n   - a\n   - b'
    expect(roundTrip(md)).toBe(md)
  })

  it('round-trips nested task list items', () => {
    const md = '- parent\n  - [x] done\n  - [ ] todo'
    expect(roundTrip(md)).toBe(md)
  })

  it('still round-trips a flat list', () => {
    expect(roundTrip('- one\n- two')).toBe('- one\n- two')
    expect(roundTrip('1. one\n2. two')).toBe('1. one\n2. two')
  })

  it('round-trips a fenced block with its language', () => {
    // The user-facing shape of the bug: open a plan, type one character in the
    // preview, save — and every ```ts in the file came back as a bare ```.
    expect(roundTrip('```ts\nconst x = 1\n```')).toBe('```ts\nconst x = 1\n```')
  })

  it('round-trips a fence that never had a language', () => {
    expect(roundTrip('```\nplain\n```')).toBe('```\nplain\n```')
  })

  it('round-trips the whole info string, not just its first word', () => {
    // Truncating at the first space would be a new silent loss in place of the
    // old one — the same defect, one word narrower.
    const md = '```js title="app.js"\nconst x = 1\n```'
    expect(roundTrip(md)).toBe(md)
  })
})
