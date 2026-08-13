/**
 * Stopping the servers `--detach` left behind.
 *
 * A command rather than something to do with `kill`, for one reason: a pid read
 * out of a listing can be stale by the time you signal it. The server may have
 * exited and the operating system handed that number to something else, and then
 * `kill` hits a bystander. This re-confirms each server is ours — an
 * authenticated request it answers — immediately before signalling it.
 *
 * SIGTERM only. That runs the server's own shutdown handler, which closes the
 * port and removes its record. SIGKILL skips both, so escalating is left to the
 * person at the keyboard.
 */
import { removeSession, sessionFile, type SessionRecord } from './session.js'
import { listSessions } from './sessions.js'

export interface StopResult {
  root: string
  port: number
  pid: number
  /** `refused` means it was signalled and had not exited by the deadline. */
  outcome: 'stopped' | 'refused'
}

export interface StopOptions {
  home: string
  /** The one workspace to stop, or null for all of them. */
  root: string | null
  /** Injected so tests need no server and no real processes. */
  isLive?: (record: SessionRecord) => Promise<boolean>
  signal?: (pid: number, sig: NodeJS.Signals) => void
  isRunning?: (pid: number) => boolean
  /** How long to wait for a signalled server to exit. */
  waitMs?: number
}

const WAIT_MS = 3000
const POLL_MS = 50

function defaultSignal(pid: number, sig: NodeJS.Signals): void {
  process.kill(pid, sig)
}

function defaultIsRunning(pid: number): boolean {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function stopSessions(options: StopOptions): Promise<StopResult[]> {
  const {
    home,
    root,
    isLive,
    signal = defaultSignal,
    isRunning = defaultIsRunning,
    waitMs = WAIT_MS,
  } = options

  // listSessions confirms each server answers and prunes the records that do
  // not, so what comes back is exactly the set that is safe to signal.
  const live = await listSessions({ home, isLive })
  const targets = root === null ? live : live.filter((s) => s.root === root)

  const results: StopResult[] = []
  for (const session of targets) {
    try {
      signal(session.pid, 'SIGTERM')
    } catch {
      // Gone between the liveness check and the signal — the outcome we wanted.
    }

    const deadline = Date.now() + waitMs
    while (isRunning(session.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    const stopped = !isRunning(session.pid)

    // The server removes its own record on a clean shutdown; doing it here too
    // means a server that died without getting the chance leaves nothing behind.
    if (stopped) await removeSession(sessionFile(home, session.root))

    results.push({
      root: session.root,
      port: session.port,
      pid: session.pid,
      outcome: stopped ? 'stopped' : 'refused',
    })
  }

  return results
}

export function describeStopped(results: StopResult[], program: string): string {
  if (results.length === 0) {
    return [
      'No sessions to stop.',
      '',
      `${program} --sessions lists what is running.`,
    ].join('\n')
  }

  const stopped = results.filter((r) => r.outcome === 'stopped')
  const refused = results.filter((r) => r.outcome === 'refused')
  const lines: string[] = []

  if (stopped.length > 0) {
    lines.push(`Stopped ${stopped.length} session${stopped.length === 1 ? '' : 's'}.`, '')
    for (const r of stopped) lines.push(`  ${r.root}`)
  }

  for (const r of refused) {
    if (lines.length > 0) lines.push('')
    lines.push(
      `${r.root} did not stop.`,
      '',
      `  Its process is still running as pid ${r.pid}. Nothing here escalates on`,
      `  your behalf, because a forced exit skips the shutdown handler and can`,
      `  leave a half-written file behind. To force it: kill -9 ${r.pid}`
    )
  }

  return lines.join('\n')
}
