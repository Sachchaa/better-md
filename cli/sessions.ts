/**
 * What is running, and where.
 *
 * `--detach` leaves a server behind on purpose, which makes "what do I have
 * running?" a question the CLI has to be able to answer. Before this, answering
 * it meant reading `~/.better-md/sessions/*.json` by hand — files that hold each
 * server's bearer token, so the obvious `cat` leaks credentials into a terminal
 * someone may well paste from.
 *
 * Liveness is proven by asking the server, never by checking the pid: ports and
 * pids are both recycled, so a pid that exists proves nothing about whose it is.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { readSession, sessionDir, sessionIsLive, type SessionRecord } from './session.js'

/** One running server, with nothing secret in it. */
export interface SessionSummary {
  root: string
  url: string
  port: number
  pid: number
  live: boolean
}

export interface ListOptions {
  home: string
  /** Injected so tests need no server; defaults to a real authenticated request. */
  isLive?: (record: SessionRecord) => Promise<boolean>
}

/**
 * Every live session, pruning the records that are not.
 *
 * A record outlives its server whenever the process could not run its shutdown
 * handler — `kill -9`, a crash, a reboot. Reporting one as though it were usable
 * is worse than not reporting it, so the stale file goes.
 */
export async function listSessions(options: ListOptions): Promise<SessionSummary[]> {
  const dir = sessionDir(options.home)
  const isLive = options.isLive ?? ((record: SessionRecord) => sessionIsLive(record))

  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    // The directory does not exist until a detached run creates it. Nothing
    // running is the normal case, not an error.
    return []
  }

  const checked = await Promise.all(
    // Concurrent, and each check is bounded by sessionIsLive's own timeout: one
    // unresponsive server delays the listing by that timeout at most, not by the
    // sum of every check before it.
    names
      // Only our own files are candidates. Anything else in there belongs to
      // someone else and must not be read or removed.
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const file = path.join(dir, name)
        const record = await readSession(file)
        if (record === null) {
          // Unreadable or malformed: it can never be reused, so it is litter.
          await fs.rm(file, { force: true })
          return null
        }
        if (!(await isLive(record))) {
          await fs.rm(file, { force: true })
          return null
        }
        return {
          root: record.root,
          url: record.url,
          port: record.port,
          pid: record.pid,
          live: true,
        }
      })
  )

  // Sorted by root so repeated runs list in the same order; readdir does not
  // promise one.
  return checked.filter((s): s is SessionSummary => s !== null).sort((a, b) => a.root.localeCompare(b.root))
}

/** The address without its token, which is the only part safe to show. */
function address(summary: SessionSummary): string {
  return `http://127.0.0.1:${summary.port}`
}

export function describeSessions(sessions: SessionSummary[], program: string): string {
  if (sessions.length === 0) {
    return [
      'No sessions running.',
      '',
      `Only a detached run records one — ${program} --detach, or the hook that`,
      `${program} init claude installs. An ordinary run writes nothing outside`,
      'the workspace.',
    ].join('\n')
  }

  const lines = sessions.map((s) => `  ${s.root}\n    ${address(s)}  pid ${s.pid}`)
  const count = `${sessions.length} session${sessions.length === 1 ? '' : 's'} running.`
  return [count, '', ...lines].join('\n')
}
