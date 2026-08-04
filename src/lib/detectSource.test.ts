import { describe, expect, it, vi } from 'vitest'
import { detectSource } from './detectSource'
import { LocalDocSource } from './docSource'
import { ServerDocSource } from './serverDocSource'

describe('detectSource', () => {
  it('returns a saving source when a token is present', () => {
    const source = detectSource('http://127.0.0.1:5173', '?t=abc123')
    expect(source.canSave).toBe(true)
    expect(source).toBeInstanceOf(ServerDocSource)
  })

  // instanceof proves the right class but says nothing about the arguments: a
  // swapped `new ServerDocSource(token, origin)` or a hardcoded token would pass
  // every other test here. Only observing an actual request settles it.
  it('constructs the server source with the given origin and token', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ files: [], active: '' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    try {
      await detectSource('http://127.0.0.1:4321', '?t=abc123').list()
    } finally {
      globalThis.fetch = original
    }

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:4321/api/workspace')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer abc123')
  })

  it('falls back to the local source for a whitespace-only token', () => {
    const source = detectSource('http://127.0.0.1:5173', '?t=%20')
    expect(source.canSave).toBe(false)
    expect(source).toBeInstanceOf(LocalDocSource)
  })

  it('returns the local source when no token is present', () => {
    const source = detectSource('http://127.0.0.1:5173', '')
    expect(source.canSave).toBe(false)
    expect(source).toBeInstanceOf(LocalDocSource)
  })

  it('ignores an empty token', () => {
    const source = detectSource('http://127.0.0.1:5173', '?t=')
    expect(source.canSave).toBe(false)
    expect(source).toBeInstanceOf(LocalDocSource)
  })

  it('ignores unrelated query parameters', () => {
    const source = detectSource('http://127.0.0.1:5173', '?theme=dark')
    expect(source.canSave).toBe(false)
    expect(source).toBeInstanceOf(LocalDocSource)
  })
})
