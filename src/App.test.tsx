import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import App from './App'
import type { DocListing, DocRead, DocSource, SaveResult, SourceEvent } from './lib/docSource'

// React checks this flag before letting `act` do its job; without it every
// state update in this file prints "not configured to support act(...)" even
// though act is being used correctly.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * A hand-written DocSource — not a mock framework, real (if tiny) state — so
 * these tests exercise App exactly the way ServerDocSource would: `list()`
 * that can reject, a `read()` keyed off mutable "disk" content, a `save()`
 * whose resolution the test can hold open, and a `subscribe()` the test
 * drives directly to fire the same events the SSE stream produces.
 */
class FakeDocSource implements DocSource {
  readonly canSave = true
  private readonly files = new Map<string, { name: string; content: string; mtimeMs: number }>()
  private readonly order: string[] = []
  private readonly listeners = new Set<(event: SourceEvent) => void>()
  private readonly saveHandlers: Array<() => Promise<SaveResult>> = []
  active = ''
  listError: Error | null = null

  seed(relPath: string, content: string, mtimeMs: number): void {
    this.files.set(relPath, { name: relPath, content, mtimeMs })
    this.order.push(relPath)
    if (this.active === '') this.active = relPath
  }

  /** Change what's "on disk" without going through the app at all. */
  setDisk(relPath: string, content: string, mtimeMs: number): void {
    const f = this.files.get(relPath)
    if (f === undefined) throw new Error(`setDisk: unknown document ${relPath}`)
    f.content = content
    f.mtimeMs = mtimeMs
  }

  /** Simulate the file vanishing on disk: read() will reject like a real 404. */
  removeDisk(relPath: string): void {
    this.files.delete(relPath)
  }

  /** Hold a save open until the test resolves it, to simulate an edit landing
   * mid-flight. Consumed FIFO; falls back to auto-succeed when empty. */
  queueSave(handler: () => Promise<SaveResult>): void {
    this.saveHandlers.push(handler)
  }

  emit(event: SourceEvent): void {
    for (const cb of this.listeners) cb(event)
  }

  async list(): Promise<DocListing> {
    if (this.listError !== null) throw this.listError
    const files = this.order.map((relPath) => {
      const f = this.files.get(relPath)
      if (f === undefined) throw new Error(`list: unknown document ${relPath}`)
      return { name: f.name, relPath, content: f.content, mtimeMs: f.mtimeMs }
    })
    return { files, active: this.active, unreadable: [] }
  }

  async read(relPath: string): Promise<DocRead> {
    const f = this.files.get(relPath)
    if (f === undefined) throw new Error(`no such document: ${relPath}`)
    return { content: f.content, mtimeMs: f.mtimeMs }
  }

  async save(relPath: string, content: string, baseMtimeMs: number | null): Promise<SaveResult> {
    const handler = this.saveHandlers.shift()
    if (handler !== undefined) return handler()
    const f = this.files.get(relPath)
    const mtimeMs = (f?.mtimeMs ?? baseMtimeMs ?? 0) + 1
    if (f !== undefined) {
      f.content = content
      f.mtimeMs = mtimeMs
    }
    return { ok: true, mtimeMs }
  }

  subscribe(callback: (event: SourceEvent) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }
}

/** All pending microtasks (however many hops the app's promise chains need)
 * are guaranteed to have run by the time a macrotask fires. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface Mounted {
  container: HTMLDivElement
  root: Root
  ref: React.RefObject<App | null>
}

async function mountApp(source: DocSource): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const ref = createRef<App>()
  await act(async () => {
    root.render(<App source={source} ref={ref} />)
    await flush()
  })
  return { container, root, ref }
}

async function unmount(m: Mounted): Promise<void> {
  await act(async () => {
    m.root.unmount()
  })
  m.container.remove()
}

describe('App data-loss guards', () => {
  it('a successful save clears dirty only for the content that landed on disk', async () => {
    const source = new FakeDocSource()
    source.seed('a.md', 'v1', 100)
    const m = await mountApp(source)
    try {
      await act(() => {
        m.ref.current!.setMd('v2', 'left')
      })
      expect(m.ref.current!.state.dirty['a.md']).toBe(true)

      let resolveSave!: (result: SaveResult) => void
      const pending = new Promise<SaveResult>((resolve) => {
        resolveSave = resolve
      })
      source.queueSave(() => pending)

      let savePromise!: Promise<void>
      await act(() => {
        savePromise = m.ref.current!.saveActive()
      })

      // An edit lands while the save above is still in flight — it must not
      // be reported as saved just because SOME version of this document was.
      await act(() => {
        m.ref.current!.setMd('v3', 'left')
      })

      await act(async () => {
        resolveSave({ ok: true, mtimeMs: 101 })
        await savePromise
        await flush()
      })

      expect(m.ref.current!.state.dirty['a.md']).toBe(true)
      expect(m.ref.current!.state.baseMtimeMs['a.md']).toBe(101)
      expect(m.ref.current!.state.md).toBe('v3')
    } finally {
      await unmount(m)
    }
  })

  it('the echo of our own write raises no conflict banner', async () => {
    const source = new FakeDocSource()
    source.seed('a.md', 'v1', 100)
    const m = await mountApp(source)
    try {
      // Mark it dirty, as if the user kept typing in the watcher's debounce
      // window right after a save — the scenario the guard exists for.
      await act(() => {
        m.ref.current!.setMd('v2', 'left')
      })
      expect(m.ref.current!.state.dirty['a.md']).toBe(true)

      // Disk is untouched: mtime and content both still match what was
      // loaded, exactly what the CLI's watcher reports back for our own
      // recently-completed write.
      await act(async () => {
        source.emit({ type: 'changed', relPath: 'a.md' })
        await flush()
      })

      expect(m.ref.current!.state.conflict).toBeNull()
      expect(m.ref.current!.state.dirty['a.md']).toBe(true)
    } finally {
      await unmount(m)
    }
  })

  it('a genuine external change while dirty raises exactly one conflict banner', async () => {
    const source = new FakeDocSource()
    source.seed('a.md', 'v1', 100)
    const m = await mountApp(source)
    try {
      await act(() => {
        m.ref.current!.setMd('v2', 'left')
      })

      source.setDisk('a.md', 'v_external', 200)
      await act(async () => {
        source.emit({ type: 'changed', relPath: 'a.md' })
        await flush()
      })

      expect(m.ref.current!.state.conflict).toEqual({
        relPath: 'a.md',
        theirContent: 'v_external',
        theirMtimeMs: 200,
      })
      // Rendered, exactly once — not silently applied (0 banners) and not
      // duplicated (>1).
      expect(m.container.querySelectorAll('[role="alert"]').length).toBe(1)
      // The unsaved edit must survive: a real change while dirty is a
      // conflict to resolve, never a silent overwrite.
      expect(m.ref.current!.state.md).toBe('v2')
    } finally {
      await unmount(m)
    }
  })

  it('a resync after reconnecting notices both a disk modification and a disk deletion', async () => {
    const source = new FakeDocSource()
    source.seed('a.md', 'a1', 100)
    source.seed('b.md', 'b1', 200)
    const m = await mountApp(source)
    try {
      // Go down — a change landing here produces no in-band event at all,
      // which is exactly why reconnecting must resync every open document.
      await act(async () => {
        source.emit({ type: 'disconnected' })
        await flush()
      })
      expect(m.ref.current!.state.watching).toBe(false)

      source.setDisk('a.md', 'a2', 101)
      source.removeDisk('b.md')

      await act(async () => {
        source.emit({ type: 'connected' })
        await flush()
      })

      // Modification: picked up and applied — a.md was clean, so no conflict.
      expect(m.ref.current!.state.baseMtimeMs['a.md']).toBe(101)
      expect(m.ref.current!.state.files.find((f) => f.relPath === 'a.md')?.content).toBe('a2')
      expect(m.ref.current!.state.md).toBe('a2')

      // Deletion: must NOT come back clean. The in-editor buffer is now the
      // only remaining copy, so it must be dirty and the unload prompt must
      // fire — silently marking it clean here is the exact bug this guards.
      expect(m.ref.current!.state.dirty['b.md']).toBe(true)
      expect(m.ref.current!.state.baseMtimeMs['b.md']).toBeNull()
      expect(m.ref.current!.state.saveError).toContain('b.md')
    } finally {
      await unmount(m)
    }
  })

  it('falls back to the first document when the listing names an active one that was dropped', async () => {
    // The exact shape a partial listing produces: `active` still names the
    // document the server chose (e.g. resolve.ts's alphabetically-first
    // bad.md), but it is no longer among `files` because it was unreadable
    // and ServerDocSource.list() already filtered it out.
    const source = new FakeDocSource()
    source.seed('a.md', 'a1', 100)
    source.seed('b.md', 'b1', 200)
    source.active = 'ghost.md'
    const m = await mountApp(source)
    try {
      const active = m.ref.current!.state.files.find((f) => f.id === m.ref.current!.state.activeId)
      expect(active?.relPath).toBe('a.md')
      expect(m.ref.current!.state.md).toBe('a1')
    } finally {
      await unmount(m)
    }
  })

  it('a failed initial list() renders an error message, not a permanent spinner', async () => {
    const source = new FakeDocSource()
    source.listError = new Error('disk exploded')
    const m = await mountApp(source)
    try {
      expect(m.ref.current!.state.loading).toBe(false)
      expect(m.ref.current!.state.loadError).toBe('disk exploded')
      expect(m.container.textContent).not.toContain('Loading documents')
      expect(m.container.textContent).toContain('disk exploded')
    } finally {
      await unmount(m)
    }
  })
})
