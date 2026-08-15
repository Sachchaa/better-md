import { describe, expect, it } from 'vitest'
import { parseBlocks, type ListBlock, type ListItem } from './blocks.js'

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

  describe('a list item wrapped over several lines', () => {
    const items = (md: string): ListItem[] => {
      const [block] = parseBlocks(md)
      expect(block.kind).toBe('list')
      return (block as ListBlock).items
    }

    it('joins an indented continuation onto the item it belongs to', () => {
      // Wrapping a long bullet at 100 columns is ordinary in a hand-written plan.
      // Ending the list at the wrap turned the rest into a stray paragraph.
      const list = items('- One command, any file. It opens the newest plan\n  your agent wrote.')
      expect(list).toHaveLength(1)
      expect(list[0].text).toBe('One command, any file. It opens the newest plan your agent wrote.')
    })

    it('keeps the numbering right afterwards', () => {
      // The damaging half of the bug: the stray paragraph split the list in two,
      // so the second <ol> restarted at 1 and every later step was misnumbered.
      const blocks = parseBlocks('1. First step which\n   wraps here.\n2. Second step.')
      expect(blocks).toHaveLength(1)
      expect((blocks[0] as ListBlock).items.map((i) => i.text)).toEqual([
        'First step which wraps here.',
        'Second step.',
      ])
    })

    it('joins several continuation lines', () => {
      expect(items('- one\n  two\n  three')[0].text).toBe('one two three')
    })

    it('still ends the list at a blank line', () => {
      const blocks = parseBlocks('- item\n\nA new paragraph.')
      expect(blocks.map((b) => b.kind)).toEqual(['list', 'paragraph'])
    })

    it('leaves a flush-left line as its own paragraph', () => {
      // Indentation is the signal. Swallowing an unindented line would be the
      // more damaging mistake: it silently eats a paragraph the author separated.
      const blocks = parseBlocks('- item\nNot a continuation.')
      expect(blocks.map((b) => b.kind)).toEqual(['list', 'paragraph'])
    })

    it('does not mistake a nested item for a continuation', () => {
      const list = items('- parent\n  - child')
      expect(list).toHaveLength(1)
      expect(list[0].text).toBe('parent')
      expect(list[0].children?.items.map((i) => i.text)).toEqual(['child'])
    })

    it('continues a nested item rather than its parent', () => {
      const list = items('- parent\n  - child which\n    wraps here')
      expect(list[0].text).toBe('parent')
      expect(list[0].children?.items[0].text).toBe('child which wraps here')
    })

    it('keeps a task marker when the item wraps', () => {
      const [item] = items('- [x] done something long\n  that wrapped')
      expect(item).toMatchObject({ text: 'done something long that wrapped', checked: true })
    })

    it('needs the indent to pass the item it would continue', () => {
      // Aligned with the nested marker rather than past it, so it is not clearly
      // that item's text. The conservative reading wins, same as flush-left.
      const blocks = parseBlocks('- parent\n  - child\n  level with the marker')
      expect(blocks.map((b) => b.kind)).toEqual(['list', 'paragraph'])
      // Trimmed on the way in: a paragraph keeps its source indent, which is
      // pre-existing behaviour and not what this test is about.
      expect((blocks[1] as { text: string }).text.trim()).toBe('level with the marker')
    })

    it('leaves a fence indented under an item as a code block', () => {
      // Structure, not prose. Swallowing the fence as continuation text left the
      // backticks in the item and lost the code block entirely — caught by an
      // existing mdToHtml test when the continuation rule first went in.
      const blocks = parseBlocks('- add this:\n  ```graphql\n  input X { id: ID! }\n  ```')
      expect(blocks.map((b) => b.kind)).toEqual(['list', 'code'])
      expect(blocks[1]).toMatchObject({ language: 'graphql', lines: ['input X { id: ID! }'] })
    })

    it('does not let a continuation end a block it should not', () => {
      // A continuation is only ever text. It must not swallow the heading after it.
      const blocks = parseBlocks('- item\n  continued\n\n## Next')
      expect(blocks.map((b) => b.kind)).toEqual(['list', 'heading'])
    })
  })
})
