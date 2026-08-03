/** Parsed command-line options. */
export interface CliOptions {
  /** File or directory path, or null when --plan was used. */
  target: string | null
  plan: boolean
  /** 0 means "let the OS pick an ephemeral port". */
  port: number
  open: boolean
}

/** One document in the workspace. `relPath` is always a bare filename. */
export interface WorkspaceFile {
  name: string
  relPath: string
}

export interface WorkspaceDescriptor {
  /** Absolute path to the directory that bounds all file access. */
  root: string
  files: WorkspaceFile[]
  /** relPath of the document to open first. */
  active: string
}

export interface WatchEvent {
  type: 'changed' | 'removed'
  relPath: string
}
