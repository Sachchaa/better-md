import { describe, expect, it } from 'vitest'
import { parseCliArgs, UsageError } from './args.js'

describe('parseCliArgs', () => {
  it('accepts a single file target', () => {
    expect(parseCliArgs(['notes.md'])).toEqual({
      target: 'notes.md',
      plan: false,
      port: null,
      open: true,
    })
  })

  it('accepts --plan with no positional', () => {
    expect(parseCliArgs(['--plan'])).toEqual({
      target: null,
      plan: true,
      port: null,
      open: true,
    })
  })

  it('rejects --plan combined with a positional target', () => {
    expect(() => parseCliArgs(['--plan', 'notes.md'])).toThrow(UsageError)
  })

  it('rejects no target at all', () => {
    expect(() => parseCliArgs([])).toThrow(UsageError)
  })

  it('rejects more than one positional', () => {
    expect(() => parseCliArgs(['a.md', 'b.md'])).toThrow(UsageError)
  })

  it('parses --port', () => {
    expect(parseCliArgs(['--port', '4321', 'a.md']).port).toBe(4321)
  })

  // null and 0 must stay distinguishable: null means "apply the default policy"
  // (prefer 8080, fall back), while an explicit 0 is a request for an ephemeral
  // port and is honoured literally. Collapsing them would make `--port 0` behave
  // like omitting the flag.
  it('distinguishes an absent --port from an explicit 0', () => {
    expect(parseCliArgs(['a.md']).port).toBeNull()
    expect(parseCliArgs(['--port', '0', 'a.md']).port).toBe(0)
  })

  it('rejects a non-numeric port', () => {
    expect(() => parseCliArgs(['--port', 'abc', 'a.md'])).toThrow(UsageError)
  })

  it('rejects an out-of-range port', () => {
    expect(() => parseCliArgs(['--port', '99999', 'a.md'])).toThrow(UsageError)
  })

  it('honours --no-open', () => {
    expect(parseCliArgs(['--no-open', 'a.md']).open).toBe(false)
  })

  it('reports --help via UsageError carrying the usage text', () => {
    expect(() => parseCliArgs(['--help'])).toThrow(UsageError)
  })
})
