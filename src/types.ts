import type { DocSource } from './lib/docSource'

export interface FileDoc {
  id: string
  name: string
  content: string
  /** Path relative to the CLI workspace root, when disk-backed. */
  relPath?: string
}

export type Theme = 'light' | 'dark'
export type Layout = 'studio' | 'tabs' | 'focus'
export type Pane = 'edit' | 'preview'
export type Side = 'init' | 'left' | 'right'

export interface Props {
  source: DocSource
  defaultTheme?: Theme
  defaultLayout?: Layout
  accentColor?: string
  syncScroll?: boolean
}

export interface ConflictState {
  relPath: string
  /** null when the document vanished on disk — there is no "theirs" to take. */
  theirContent: string | null
  theirMtimeMs: number | null
}

export interface State {
  files: FileDoc[]
  activeId: string
  md: string
  theme: Theme
  layout: Layout
  focusPane: Pane
  editingSide: Side
  dragOver: boolean
  /** id of the file whose name is being edited inline, or null. */
  renamingId: string | null
  /** True until the first list() resolves. */
  loading: boolean
  /** relPath → has unsaved edits. */
  dirty: Record<string, boolean>
  /** relPath → mtime the content was loaded at, or null for non-disk docs. */
  baseMtimeMs: Record<string, number | null>
  conflict: ConflictState | null
  saving: boolean
  saveError: string | null
  /** False while the live-update channel is down, so the UI stops implying it is live. */
  watching: boolean
}
