/**
 * Records where a detached server is listening, so a second `--detach` can reuse
 * it instead of stacking another ~110 MB process.
 *
 * This is the only thing better-md writes outside a workspace, and it is written
 * ONLY for detached runs — an ordinary foreground `better-md notes.md` still
 * leaves nothing behind. The reuse it enables is not optional for the intended
 * use: a hook that fires on every finished plan would otherwise start a new
 * server each time.
 *
 * It doubles as the handshake between a `--detach` parent and the child it
 * spawns. The child writes the record once it is listening; the parent polls for
 * it. Using the file rather than the child's stdout means the parent can exit
 * without leaving the child writing into a broken pipe.
 */
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface SessionRecord {
  url: string
  port: number
  token: string
  root: string
  pid: number
}

/** The directory holding session records; removed wholesale by `uninstall`. */
export function sessionDir(home: string): string {
  return path.join(home, '.better-md', 'sessions')
}

/**
 * One file per workspace root, named by its hash.
 *
 * Per-root rather than a single shared file so two detached servers for
 * different directories never race on the same write.
 */
export function sessionFile(home: string, root: string): string {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 16)
  return path.join(sessionDir(home), `${key}.json`)
}

export async function writeSession(file: string, record: SessionRecord): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(record), 'utf8')
}

export async function readSession(file: string): Promise<SessionRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<SessionRecord>
    if (
      typeof parsed.url !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.root !== 'string' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.pid !== 'number'
    ) {
      return null
    }
    return parsed as SessionRecord
  } catch {
    // Absent, unreadable or malformed all mean the same thing to the caller:
    // there is no session to reuse.
    return null
  }
}

export async function removeSession(file: string): Promise<void> {
  await fs.rm(file, { force: true })
}

/**
 * Synchronous removal, for the shutdown path.
 *
 * `void removeSession(f); process.exit(0)` looks fine and does not work — exit
 * fires before the async unlink lands, so every stopped server left its record
 * behind. In a signal handler the removal has to complete inline.
 */
export function removeSessionSync(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    // A leftover record is harmless: the liveness probe rejects it. Failing to
    // shut down cleanly would not be.
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Is this record still a live better-md?
 *
 * Asks the server rather than checking the pid. A pid can be recycled onto an
 * unrelated process, and the port can be taken over by something else entirely —
 * only a successful authenticated request proves the thing listening is ours.
 */
/**
 * How long to wait for a recorded server to answer.
 *
 * Node's fetch has no default timeout, so a process still holding the port but
 * no longer replying would hang the caller forever. Generous for a loopback
 * request, short enough that a listing does not feel stuck.
 */
const LIVENESS_TIMEOUT_MS = 2000

export async function sessionIsLive(
  record: SessionRecord,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = LIVENESS_TIMEOUT_MS
): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${record.port}/api/workspace`, {
      headers: { authorization: `Bearer ${record.token}` },
      // A signal rather than a bare race, so the socket is actually torn down
      // instead of left open behind an abandoned promise.
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return false
    await res.text()
    return true
  } catch {
    return false
  }
}
