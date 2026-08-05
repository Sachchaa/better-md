/** Parsed command-line options. */
export interface CliOptions {
  /** File or directory path, or null when --plan was used. */
  target: string | null
  plan: boolean
  /**
   * The port asked for, or null when --port was not passed.
   *
   * null is distinct from 0: null means "no preference, apply the default policy"
   * (prefer PREFERRED_PORT, fall back to ephemeral), while an explicit 0 means the
   * caller specifically asked the OS to pick one. Collapsing the two would make
   * `--port 0` indistinguishable from omitting the flag.
   */
  port: number | null
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
