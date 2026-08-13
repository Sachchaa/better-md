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
  /** Which agent's plans --plan should open; null means whichever wrote last. */
  agent: string | null
  /** Start the server, print the URL and return, instead of holding the terminal. */
  detach: boolean
  /** Render in the terminal instead of serving the browser editor. */
  terminal: boolean
  /** A subcommand that replaces the normal "open a workspace" run. */
  command: 'update' | 'uninstall' | 'init' | 'stop' | null
  /** Which agent `init` should configure. */
  initTarget: string | null
  /**
   * Which workspace `stop` should stop; null means every running session.
   *
   * A subcommand rather than a flag because it acts, and a verb nobody names a
   * directory after — the reason `--sessions`, a plural noun, is a flag.
   */
  stopTarget: string | null
  /** `init` writes to the agent's config only when asked. */
  write: boolean
  /** --check-updates: report whether a newer release exists, then exit. */
  checkUpdates: boolean
  /**
   * --sessions: list the detached servers that are running, then exit.
   *
   * A flag rather than a bare `sessions` word, which would shadow a directory of
   * that name — a plural noun is a plausible folder in a Markdown workspace, where
   * `update` and `uninstall` are verbs nobody names one. It also matches the line
   * the CLI already draws: subcommands act, flags ask.
   */
  sessions: boolean
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
