import { describe, expect, it, vi } from 'vitest'
import type { SourceEvent } from './docSource'
import { ServerDocSource } from './serverDocSource'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('ServerDocSource', () => {
  it('can save', () => {
    expect(new ServerDocSource('http://127.0.0.1:1', 'tok', vi.fn()).canSave).toBe(true)
  })

  it('sends the bearer token when listing', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      void url
      void init
      return jsonResponse({ files: [{ name: 'a.md', relPath: 'a.md' }], active: 'a.md' })
    })
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    await source.list()

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })

  it('preloads content for every listed file and preserves the active file', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.includes('/api/workspace')) {
        return jsonResponse({
          files: [
            { name: 'a.md', relPath: 'a.md' },
            { name: 'b.md', relPath: 'b.md' },
          ],
          // The server activates the newest plan, not the first alphabetically.
          active: 'b.md',
        })
      }
      const relPath = new URL(input).searchParams.get('path')
      return jsonResponse({ relPath, content: `body of ${relPath}`, mtimeMs: 100 })
    })
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const listing = await source.list()

    expect(listing.files).toEqual([
      { name: 'a.md', relPath: 'a.md', content: 'body of a.md', mtimeMs: 100 },
      { name: 'b.md', relPath: 'b.md', content: 'body of b.md', mtimeMs: 100 },
    ])
    expect(listing.active).toBe('b.md')
  })

  it('returns ok on a successful save', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ mtimeMs: 999 }))
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const result = await source.save('a.md', 'text', 100)

    expect(result).toEqual({ ok: true, mtimeMs: 999 })
  })

  it('maps a 409 to a conflict result', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ theirContent: 'theirs', theirMtimeMs: 500 }, 409)
    )
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const result = await source.save('a.md', 'mine', 100)

    expect(result).toEqual({
      ok: false,
      reason: 'conflict',
      theirContent: 'theirs',
      theirMtimeMs: 500,
    })
  })

  it('maps a 500 to an error result carrying the message', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'disk full' }, 500))
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const result = await source.save('a.md', 'mine', 100)

    expect(result).toEqual({ ok: false, reason: 'error', message: 'disk full' })
  })

  it('maps a rejected fetch to an error result', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const result = await source.save('a.md', 'mine', 100)

    expect(result).toEqual({ ok: false, reason: 'error', message: 'network down' })
  })

  it('parses SSE frames into change events', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(': connected\n\ndata: {"type":"changed","relPath":"a.md"}\n\n')
        )
        controller.close()
      },
    })
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }))
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const seen: SourceEvent[] = []
    const unsubscribe = source.subscribe((event) => seen.push(event))
    await vi.waitFor(() => expect(seen.some((e) => e.type === 'changed')).toBe(true))
    unsubscribe()

    // 'connected' lands first so the UI can show a live indicator.
    expect(seen[0]).toEqual({ type: 'connected' })
    expect(seen.find((e) => e.type === 'changed')).toEqual({ type: 'changed', relPath: 'a.md' })
  })

  it('reports disconnection when the stream fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }))
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const seen: SourceEvent[] = []
    const unsubscribe = source.subscribe((event) => seen.push(event))
    await vi.waitFor(() => expect(seen.some((e) => e.type === 'disconnected')).toBe(true))
    unsubscribe()

    expect(seen).toContainEqual({ type: 'disconnected' })
  })
})
