import { describe, expect, it } from 'vitest'
import { serverArgs } from './detach.js'

describe('serverArgs', () => {
  it('drops --detach, since the child is the server', () => {
    expect(serverArgs(['--detach', 'plan.md'])).toEqual(['plan.md'])
  })

  it('drops --terminal and its shorthand', () => {
    // The child exists to serve the browser editor. Inheriting --terminal would
    // start a second viewer with no server, and the handshake would never
    // complete.
    expect(serverArgs(['--terminal', 'plan.md'])).toEqual(['plan.md'])
    expect(serverArgs(['-t', 'plan.md'])).toEqual(['plan.md'])
  })

  it('keeps everything that describes what to serve', () => {
    expect(serverArgs(['--plan', '--agent', 'cursor', '--port', '3000'])).toEqual([
      '--plan',
      '--agent',
      'cursor',
      '--port',
      '3000',
    ])
  })

  it('keeps an option value that happens to look like a dropped flag', () => {
    // `--agent -t` is nonsense, but dropping the value would silently change
    // `--agent` into a flag with no argument and shift everything after it.
    expect(serverArgs(['--agent', '-t'])).toEqual(['--agent', '-t'])
  })

  it('leaves a plain invocation alone', () => {
    expect(serverArgs(['plan.md'])).toEqual(['plan.md'])
    expect(serverArgs([])).toEqual([])
  })
})
