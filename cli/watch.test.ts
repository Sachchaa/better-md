import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchWorkspace, type WatcherFactory } from './watch.js'
import type { WatchEvent } from './types.js'

type Emit = (event: string, filename: string | null) => void

function stubFactory(): { factory: WatcherFactory; emit: Emit; closed: () => boolean } {
  let emit: Emit = () => {}
  let closed = false
  const factory: WatcherFactory = (_root, cb) => {
    emit = cb
    return {
      close: () => {
        closed = true
      },
    }
  }
  return { factory, emit: (e, f) => emit(e, f), closed: () => closed }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('watchWorkspace', () => {
  it('emits a changed event after the debounce window', () => {
    const events: WatchEvent[] = []
    const { factory, emit } = stubFactory()
    watchWorkspace('/root', (e) => events.push(e), { debounceMs: 50, factory, exists: () => true })

    emit('change', 'notes.md')
    expect(events).toEqual([])

    vi.advanceTimersByTime(50)
    expect(events).toEqual([{ type: 'changed', relPath: 'notes.md' }])
  })

  it('collapses a burst of writes into one event', () => {
    const events: WatchEvent[] = []
    const { factory, emit } = stubFactory()
    watchWorkspace('/root', (e) => events.push(e), { debounceMs: 50, factory, exists: () => true })

    emit('change', 'notes.md')
    vi.advanceTimersByTime(20)
    emit('change', 'notes.md')
    vi.advanceTimersByTime(20)
    emit('change', 'notes.md')
    vi.advanceTimersByTime(50)

    expect(events).toEqual([{ type: 'changed', relPath: 'notes.md' }])
  })

  it('debounces each file independently', () => {
    const events: WatchEvent[] = []
    const { factory, emit } = stubFactory()
    watchWorkspace('/root', (e) => events.push(e), { debounceMs: 50, factory, exists: () => true })

    emit('change', 'a.md')
    emit('change', 'b.md')
    vi.advanceTimersByTime(50)

    expect(events.map((e) => e.relPath).sort()).toEqual(['a.md', 'b.md'])
  })

  it('ignores files with unsupported extensions', () => {
    const events: WatchEvent[] = []
    const { factory, emit } = stubFactory()
    watchWorkspace('/root', (e) => events.push(e), { debounceMs: 50, factory, exists: () => true })

    emit('change', 'image.png')
    emit('change', 'notes.md.swp')
    vi.advanceTimersByTime(50)

    expect(events).toEqual([])
  })

  it('ignores paths that are not bare filenames', () => {
    const events: WatchEvent[] = []
    const { factory, emit } = stubFactory()
    watchWorkspace('/root', (e) => events.push(e), { debounceMs: 50, factory, exists: () => true })

    emit('change', 'sub/nested.md')
    emit('change', null)
    vi.advanceTimersByTime(50)

    expect(events).toEqual([])
  })

  it('reports a vanished file as removed', () => {
    const events: WatchEvent[] = []
    const { factory, emit } = stubFactory()
    watchWorkspace('/root', (e) => events.push(e), {
      debounceMs: 50,
      factory,
      exists: () => false,
    })

    emit('rename', 'gone.md')
    vi.advanceTimersByTime(50)

    expect(events).toEqual([{ type: 'removed', relPath: 'gone.md' }])
  })

  it('closes the underlying watcher and stops emitting', () => {
    const events: WatchEvent[] = []
    const { factory, emit, closed } = stubFactory()
    const stop = watchWorkspace('/root', (e) => events.push(e), {
      debounceMs: 50,
      factory,
      exists: () => true,
    })

    emit('change', 'notes.md')
    stop()
    vi.advanceTimersByTime(50)

    expect(closed()).toBe(true)
    expect(events).toEqual([])
  })
})
