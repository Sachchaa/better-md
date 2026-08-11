/**
 * Starting, or reusing, a background server for a workspace.
 *
 * Its own module because two callers need it — `--detach` and terminal mode's
 * browser handoff — and importing it from `cli/index.ts` would make the graph
 * circular.
 */
import { spawn } from 'node:child_process'
import { openBrowser } from './open.js'
import { ResolveError } from './resolve.js'
import { readSession, removeSession, sessionIsLive } from './session.js'

/**
 * Flags that describe *this* process rather than what to serve.
 *
 * The child is the server. Inheriting `--terminal` would start a second viewer
 * with no server behind it, and the handshake would never complete.
 */
const NOT_INHERITED = new Set(['--detach', '--terminal', '-t'])

/** Options whose next argument is a value, not a flag. */
const TAKES_VALUE = new Set(['--agent', '--port'])

/**
 * The arguments to re-spawn with.
 *
 * A token immediately after a value-taking option is kept even if it looks like
 * a dropped flag: `--agent -t` is nonsense, but removing the value would turn
 * `--agent` into a bare flag and shift everything after it.
 */
export function serverArgs(argv: string[]): string[] {
  return argv.filter((arg, index) => {
    if (index > 0 && TAKES_VALUE.has(argv[index - 1])) return true
    return !NOT_INHERITED.has(arg)
  })
}

export interface DetachOptions {
  /** Path to this workspace's session record. */
  session: string
  open: boolean
  /**
   * Whether this is a packaged single executable.
   *
   * Passed in rather than read from `node:sea` here, so this module stays
   * importable by the test runner — vitest cannot resolve `node:sea`.
   */
  packaged: boolean
  /**
   * Where the URL is reported.
   *
   * A callback rather than a write to stdout: terminal mode owns the screen, and
   * a stray line would land in the middle of the rendered document.
   */
  announce?: (url: string) => void
}

/**
 * Reuse a live server for this workspace, or start one in the background.
 *
 * Reuse matters because the intended caller is a hook that fires on every
 * finished plan: without it, each plan would leave another ~110 MB server
 * running. Liveness is proven by an authenticated request rather than a pid
 * check — ports and pids both get recycled.
 */
export async function runDetached(options: DetachOptions): Promise<string> {
  const { session, open, packaged, announce } = options

  const finish = (url: string): string => {
    announce?.(url)
    if (open) openBrowser(url)
    return url
  }

  const existing = await readSession(session)
  if (existing !== null && (await sessionIsLive(existing))) return finish(existing.url)
  await removeSession(session)

  // stdio is ignored and the child unref'd, so this process can exit without
  // killing it or leaving it writing to a dead pipe; the session file is the
  // handshake instead.
  const args = serverArgs(process.argv.slice(2))
  const child = spawn(process.execPath, packaged ? args : [process.argv[1], ...args], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, BETTER_MD_SESSION: session },
  })
  child.unref()

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const record = await readSession(session)
    if (record !== null && (await sessionIsLive(record))) return finish(record.url)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new ResolveError('the background server did not start within 15s')
}
