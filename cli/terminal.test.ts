import { describe, expect, it } from 'vitest'
import { canRunInteractively, renderOnce } from './terminal.js'

describe('canRunInteractively', () => {
  it('runs the viewer when both ends are a terminal', () => {
    expect(canRunInteractively({ isTTY: true }, { isTTY: true })).toBe(true)
  })

  it('refuses when output is redirected', () => {
    // `better-md -t plan.md > out.txt` used to enter the alt screen and hang
    // forever: escape codes went into the file and no keypress could ever
    // arrive to quit.
    expect(canRunInteractively({ isTTY: false }, { isTTY: true })).toBe(false)
  })

  it('refuses when input is not a terminal', () => {
    // Without a tty on stdin there is no way to send the quit key, so an
    // interactive viewer would hold the shell with no way out.
    expect(canRunInteractively({ isTTY: true }, { isTTY: false })).toBe(false)
  })

  it('treats a missing isTTY as not a terminal', () => {
    expect(canRunInteractively({}, {})).toBe(false)
  })
})

describe('renderOnce', () => {
  const env = { LANG: 'en_US.UTF-8' }

  it('renders the document as plain text', () => {
    const out = renderOnce('# Title\n\nsome body', { columns: 40, env })
    expect(out).toContain('Title')
    expect(out).toContain('some body')
  })

  it('emits no escape sequences, because the destination is a file or a pager', () => {
    const out = renderOnce('# Title\n\n**bold** and `code`', { columns: 40, env })
    expect(out).not.toContain('\x1b')
    expect(out).toContain('bold')
  })

  it('ends with a newline so a shell prompt starts on its own line', () => {
    expect(renderOnce('# Title', { columns: 40, env }).endsWith('\n')).toBe(true)
  })

  it('falls back to 80 columns when the width is unknown', () => {
    // A pipe reports no width at all. Passing undefined through produced NaN
    // arithmetic and a blank pane.
    const out = renderOnce('word '.repeat(60).trim(), { columns: undefined, env })
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
    expect(out).toContain('word')
  })

  it('uses ASCII when the locale is not UTF-8', () => {
    const out = renderOnce('- [x] done', { columns: 40, env: {} })
    expect(out).toContain('[x] done')
    expect(out).not.toContain('✓')
  })
})
