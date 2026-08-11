import { describe, expect, it } from 'vitest'
import { parseBlocks } from '../blocks.js'
import { renderDocument } from './render.js'

/** Roughly 8,000 rendered lines — a long plan, not a pathological one. */
const bigDocument = Array.from(
  { length: 1000 },
  (_, i) => `## Section ${i}\n\nBody text for section ${i}.\n\n- [x] done\n- [ ] todo\n`
).join('\n')

describe('render performance', () => {
  it('renders a large document well under a frame budget', () => {
    const blocks = parseBlocks(bigDocument)
    const started = performance.now()
    renderDocument(blocks, { width: 100, unicode: true, colour: true })
    // Live reload re-renders on every agent write. A slow render is felt as the
    // document lagging behind the agent, which is the one thing this mode is for.
    expect(performance.now() - started).toBeLessThan(250)
  })

  it('parses and renders a large document in one pass under the budget', () => {
    // The reload path does both, so the budget that matters covers both.
    const started = performance.now()
    renderDocument(parseBlocks(bigDocument), { width: 100, unicode: true, colour: true })
    expect(performance.now() - started).toBeLessThan(400)
  })

  it('does not degrade sharply on a document of very long lines', () => {
    // Wrapping is the per-character part of the work, so a document that is all
    // prose is the worst case for it.
    const prose = Array.from({ length: 400 }, () => 'word '.repeat(200).trim()).join('\n\n')
    const started = performance.now()
    renderDocument(parseBlocks(prose), { width: 80, unicode: true, colour: true })
    expect(performance.now() - started).toBeLessThan(400)
  })
})
