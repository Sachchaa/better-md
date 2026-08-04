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
  defaultTheme?: Theme
  defaultLayout?: Layout
  accentColor?: string
  syncScroll?: boolean
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
}
