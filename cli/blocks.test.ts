import { describe, expect, it } from 'vitest'
import { parseBlocks } from './blocks.js'

describe('parseBlocks', () => {
  it('reads headings with their level', () => {
    expect(parseBlocks('# Title')).toEqual([{ kind: 'heading', level: 1, text: 'Title' }])
    expect(parseBlocks('### Sub')).toEqual([{ kind: 'heading', level: 3, text: 'Sub' }])
  })

  it('keeps a fenced block intact, with its language', () => {
    expect(parseBlocks('```ts\nconst a = 1\n```')).toEqual([
      { kind: 'code', language: 'ts', lines: ['const a = 1'] },
    ])
  })

  it('separates a task item from a plain one', () => {
    const [list] = parseBlocks('- [x] done\n- plain')
    expect(list).toEqual({
      kind: 'list',
      ordered: false,
      items: [
        { text: 'done', checked: true, children: null },
        { text: 'plain', checked: null, children: null },
      ],
    })
  })

  it('nests by relative indentation', () => {
    const [list] = parseBlocks('- a\n  - b')
    expect(list).toMatchObject({
      items: [{ text: 'a', children: { kind: 'list', items: [{ text: 'b' }] } }],
    })
  })

  it('needs a delimiter row before it calls something a table', () => {
    expect(parseBlocks('choose a | b')).toEqual([{ kind: 'paragraph', text: 'choose a | b' }])
    expect(parseBlocks('| a |\n| --: |\n| 1 |')).toEqual([
      { kind: 'table', header: ['a'], aligns: ['right'], rows: [['1']] },
    ])
  })

  it('does not interpret Markdown inside a fence', () => {
    // The fence body is data. Emitting a heading from it would be a parser bug
    // that both renderers would then inherit.
    expect(parseBlocks('```\n# not a heading\n```')).toEqual([
      { kind: 'code', language: '', lines: ['# not a heading'] },
    ])
  })

  it('reads blockquotes and rules', () => {
    expect(parseBlocks('> quoted')).toEqual([{ kind: 'quote', text: 'quoted' }])
    expect(parseBlocks('---')).toEqual([{ kind: 'rule' }])
  })

  it('keeps an ordered list ordered', () => {
    expect(parseBlocks('1. one\n2. two')).toMatchObject({ 0: { kind: 'list', ordered: true } })
  })

  it('returns nothing for an empty document', () => {
    expect(parseBlocks('')).toEqual([])
  })

  it('carries inline syntax through untouched', () => {
    // Inline formatting is each renderer's job: the HTML one has to escape, the
    // terminal one has to style. Parsing it here would put escaping in a module
    // that knows nothing about HTML.
    expect(parseBlocks('a **b** `c`')).toEqual([{ kind: 'paragraph', text: 'a **b** `c`' }])
  })
})
