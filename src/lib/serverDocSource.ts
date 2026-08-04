import type { DocListing, DocRead, DocSource, SaveResult, SourceEvent } from './docSource'

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 10_000

/** Disk-backed source: every call carries the bearer token. */
export class ServerDocSource implements DocSource {
  readonly canSave = true

  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly origin: string,
    private readonly token: string,
    fetchImpl?: typeof fetch
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra }
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: this.headers(init?.headers as Record<string, string>),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `request failed with ${res.status}`)
    }
    return (await res.json()) as T
  }

  async list(): Promise<DocListing> {
    const listing = await this.json<{
      files: Array<{ name: string; relPath: string }>
      active: string
    }>(`${this.origin}/api/workspace`)
    const settled = await Promise.allSettled(
      listing.files.map(async (file) => {
        // read() already returns the mtime — keep it rather than re-fetching.
        const doc = await this.read(file.relPath)
        return {
          name: file.name,
          relPath: file.relPath,
          content: doc.content,
          mtimeMs: doc.mtimeMs,
        }
      })
    )
    // One unreadable document must not cost the user the whole workspace. Drop the
    // failures and report them; the readable ones still open.
    const files = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const unreadable = listing.files
      .filter((f) => !files.some((k) => k.relPath === f.relPath))
      .map((f) => f.relPath)
    return { files, active: listing.active, unreadable }
  }

  async read(relPath: string): Promise<DocRead> {
    const doc = await this.json<{ content: string; mtimeMs: number }>(
      `${this.origin}/api/doc?path=${encodeURIComponent(relPath)}`
    )
    return { content: doc.content, mtimeMs: doc.mtimeMs }
  }

  async save(relPath: string, content: string, baseMtimeMs: number | null): Promise<SaveResult> {
    try {
      const res = await this.fetchImpl(`${this.origin}/api/doc`, {
        method: 'PUT',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ relPath, content, baseMtimeMs }),
      })
      if (res.status === 409) {
        const body = (await res.json()) as {
          theirContent: string | null
          theirMtimeMs: number | null
        }
        return {
          ok: false,
          reason: 'conflict',
          theirContent: body.theirContent,
          theirMtimeMs: body.theirMtimeMs,
        }
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        return { ok: false, reason: 'error', message: body.error ?? `save failed (${res.status})` }
      }
      const body = (await res.json()) as { mtimeMs: number }
      return { ok: true, mtimeMs: body.mtimeMs }
    } catch (err) {
      return {
        ok: false,
        reason: 'error',
        message: err instanceof Error ? err.message : 'save failed',
      }
    }
  }

  /**
   * Consume the SSE stream with fetch so the Authorization header can be set —
   * EventSource cannot send custom headers.
   */
  subscribe(callback: (event: SourceEvent) => void): () => void {
    let stopped = false
    let attempt = 0
    let controller: AbortController | null = null
    let backoffTimer: ReturnType<typeof setTimeout> | null = null

    const run = async (): Promise<void> => {
      while (!stopped) {
        controller = new AbortController()
        // Set when the response itself said 401, as opposed to a network
        // failure or any other status — the one case where retrying is
        // guaranteed never to succeed, so it must not fall into the generic
        // catch below and get the same treatment as a transient drop.
        let authExpired = false
        try {
          const res = await this.fetchImpl(`${this.origin}/api/events`, {
            headers: this.headers(),
            signal: controller.signal,
          })
          if (res.status === 401) {
            authExpired = true
            throw new Error('events failed (401)')
          }
          if (!res.ok || res.body === null) throw new Error(`events failed (${res.status})`)
          attempt = 0
          callback({ type: 'connected' })
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (!stopped) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const frames = buffer.split('\n\n')
            buffer = frames.pop() ?? ''
            for (const frame of frames) {
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue
                try {
                  callback(JSON.parse(line.slice(5).trim()) as SourceEvent)
                } catch {
                  // Ignore malformed frames rather than tearing down the stream.
                }
              }
            }
          }
        } catch {
          // Fall through to the backoff below.
        }
        if (stopped) return

        if (authExpired) {
          // Terminal: the token is minted per CLI run and never persisted, so
          // a 401 here means the CLI that issued it is gone, not that the
          // network hiccuped. No amount of retrying can ever succeed — the
          // only fix is reopening the URL the CLI printed for its current
          // run. Inside a try for the same reason as the 'disconnected'
          // callback below: a broken subscriber must not become an unhandled
          // rejection out of the fire-and-forget `void run()`.
          try {
            callback({ type: 'auth-expired' })
          } catch {
            // A broken subscriber is not the stream's problem.
          }
          return
        }

        // Inside a try: a subscriber callback that throws must not become an
        // unhandled rejection out of the fire-and-forget `void run()` below.
        try {
          callback({ type: 'disconnected' })
        } catch {
          // A broken subscriber is not the stream's problem.
        }

        attempt += 1
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)
        // Hold the handle so unsubscribe can cancel it. `stopped` alone would
        // stop the next iteration, but the timer itself would stay pending —
        // the same "muted, not cancelled" gap the watcher had to fix earlier in
        // this plan, and in a browser a repeatedly mounted component would
        // accumulate one live timer per unsubscribe.
        await new Promise<void>((resolve) => {
          backoffTimer = setTimeout(() => {
            backoffTimer = null
            resolve()
          }, delay)
        })
      }
    }

    void run()

    return () => {
      stopped = true
      controller?.abort()
      if (backoffTimer !== null) {
        clearTimeout(backoffTimer)
        backoffTimer = null
      }
    }
  }
}
