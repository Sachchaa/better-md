import fs from 'node:fs'
import path from 'node:path'
import { DOC_EXTENSIONS } from './resolve.js'
import type { WatchEvent } from './types.js'

export interface RawWatcher {
  close(): void
}

export type WatcherFactory = (
  root: string,
  cb: (event: string, filename: string | null) => void
) => RawWatcher

export const nodeWatcherFactory: WatcherFactory = (root, cb) => {
  const watcher = fs.watch(root, { persistent: true }, cb)
  // FSWatcher is an EventEmitter, so an unhandled 'error' would throw and take
  // the whole CLI down. Losing live updates is recoverable; losing the server
  // mid-edit is not. Report and carry on serving.
  watcher.on('error', (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`better-md: stopped watching ${root}: ${message}\n`)
  })
  return watcher
}

export interface WatchOptions {
  debounceMs?: number
  factory?: WatcherFactory
  /** Existence probe, injectable so tests stay hermetic. */
  exists?: (absPath: string) => boolean
}

/**
 * Watch `root` for document changes, collapsing bursts per file. Editors and
 * agents commonly write a file several times in quick succession; without
 * debouncing the client would reload mid-write and see truncated content.
 */
export function watchWorkspace(
  root: string,
  onEvent: (event: WatchEvent) => void,
  options: WatchOptions = {}
): () => void {
  const debounceMs = options.debounceMs ?? 50
  const factory = options.factory ?? nodeWatcherFactory
  const exists = options.exists ?? ((abs: string) => fs.existsSync(abs))
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let stopped = false

  const watcher = factory(root, (_event, filename) => {
    if (stopped || filename === null) return
    // fs.watch can report nested or non-document paths; only bare docs matter.
    if (filename !== path.basename(filename)) return
    const ext = path.extname(filename).toLowerCase()
    if (!(DOC_EXTENSIONS as readonly string[]).includes(ext)) return

    const existing = timers.get(filename)
    if (existing !== undefined) clearTimeout(existing)
    timers.set(
      filename,
      setTimeout(() => {
        timers.delete(filename)
        if (stopped) return
        const present = exists(path.join(root, filename))
        onEvent({ type: present ? 'changed' : 'removed', relPath: filename })
      }, debounceMs)
    )
  })

  return () => {
    stopped = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    watcher.close()
  }
}
