import { SAMPLE_NOTES, SAMPLE_README, SAMPLE_TODO } from './samples'

export interface DocFile {
  name: string
  relPath: string
  content: string
  /**
   * mtime the content was read at, or null when not disk-backed. Carried here
   * so a listing is self-sufficient: the save conflict check needs it, and
   * re-fetching it would both duplicate requests and leave a window where a
   * save is wrongly treated as a new-file create.
   */
  mtimeMs: number | null
}

export interface DocRead {
  content: string
  /** null when the document is not backed by a file on disk. */
  mtimeMs: number | null
}

export interface SaveOk {
  ok: true
  mtimeMs: number | null
}

export interface SaveConflict {
  ok: false
  reason: 'conflict'
  theirContent: string
  theirMtimeMs: number
}

export interface SaveFailed {
  ok: false
  reason: 'error'
  message: string
}

export type SaveResult = SaveOk | SaveConflict | SaveFailed

export interface DocListing {
  files: DocFile[]
  /** relPath to open first. For --plan this is the newest plan, not the first. */
  active: string
}

export interface ChangeEvent {
  type: 'changed' | 'removed'
  relPath: string
}

/** Emitted when the live-update channel connects or drops. */
export interface StatusEvent {
  type: 'connected' | 'disconnected'
}

export type SourceEvent = ChangeEvent | StatusEvent

/** Where documents come from, and whether they can go back. */
export interface DocSource {
  canSave: boolean
  list(): Promise<DocListing>
  read(relPath: string): Promise<DocRead>
  save(relPath: string, content: string, baseMtimeMs: number | null): Promise<SaveResult>
  /** Returns an unsubscribe function. */
  subscribe(callback: (event: SourceEvent) => void): () => void
}

const SAMPLES: DocFile[] = [
  { name: 'README.md', relPath: 'README.md', content: SAMPLE_README, mtimeMs: null },
  { name: 'notes.md', relPath: 'notes.md', content: SAMPLE_NOTES, mtimeMs: null },
  { name: 'todo.md', relPath: 'todo.md', content: SAMPLE_TODO, mtimeMs: null },
]

/** Browser-only mode: seeded samples, in-memory, export-to-download. */
export class LocalDocSource implements DocSource {
  readonly canSave = false

  private docs: DocFile[] = SAMPLES.map((doc) => ({ ...doc }))

  async list(): Promise<DocListing> {
    return { files: this.docs.map((doc) => ({ ...doc })), active: 'README.md' }
  }

  async read(relPath: string): Promise<DocRead> {
    const doc = this.docs.find((d) => d.relPath === relPath)
    if (doc === undefined) throw new Error(`unknown document: ${relPath}`)
    return { content: doc.content, mtimeMs: null }
  }

  // Not disk-backed: parameters are part of the DocSource contract but unused here.
  async save(relPath: string, content: string, baseMtimeMs: number | null): Promise<SaveResult> {
    void relPath
    void content
    void baseMtimeMs
    return {
      ok: false,
      reason: 'error',
      message: 'This document is not backed by a file on disk. Use Export instead.',
    }
  }

  subscribe(callback: (event: SourceEvent) => void): () => void {
    void callback
    return () => {}
  }
}
