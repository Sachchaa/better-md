/**
 * Remove an installed better-md.
 *
 * `rm $(command -v better-md)` is the obvious thing to reach for and it is
 * incomplete: the installer writes a second copy as `btr-md`, so the obvious
 * command leaves ~110 MB on PATH, still runnable. This removes both and says
 * exactly which files went.
 *
 * Identity is decided by content, not by filename — a `btr-md` that is not a copy
 * of the running binary belongs to someone else and is left alone, and said so.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** The names the installer writes. Kept beside programName's BIN_NAMES. */
const INSTALLED_NAMES = ['better-md', 'btr-md']

export class UninstallError extends Error {}

export interface UninstallOptions {
  /** Absolute path of the running executable, or null when not a packaged build. */
  executable: string | null
  /**
   * State directory to remove alongside the binaries — the session records that
   * `--detach` writes. Omit to leave it alone.
   */
  stateDir?: string | null
  log: (message: string) => void
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex')
}

/** Removes the install and returns the paths it deleted. */
export async function uninstall(options: UninstallOptions): Promise<string[]> {
  const { executable, log } = options

  if (executable === null) {
    throw new UninstallError(
      'this is not an installed build, so there is nothing to uninstall.\n' +
        'Running from a checkout? Delete the checkout instead.'
    )
  }

  const dir = path.dirname(executable)
  const self = await sha256(executable)

  // Siblings first, then the running binary last: if removing a sibling fails,
  // the user still has a working better-md to try again with.
  const targets = [executable]
  for (const name of INSTALLED_NAMES) {
    const candidate = path.join(dir, name)
    if (candidate === executable) continue
    let same: boolean
    try {
      same = (await sha256(candidate)) === self
    } catch {
      continue // not there, nothing to remove
    }
    if (same) {
      targets.unshift(candidate)
    } else {
      log(`left ${candidate} alone — it is not a copy of this binary`)
    }
  }

  // Detached runs record where they are listening; those records are the only
  // thing better-md keeps outside a workspace, so uninstall has to take them too
  // or the "nothing else on disk" claim stops being true.
  if (options.stateDir !== undefined && options.stateDir !== null) {
    try {
      await fs.rm(options.stateDir, { recursive: true, force: true })
    } catch {
      log(`could not remove ${options.stateDir}; delete it by hand`)
    }
  }

  const removed: string[] = []
  for (const target of targets) {
    try {
      await fs.unlink(target)
      removed.push(target)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') continue
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        throw new UninstallError(
          `cannot remove ${target}: permission denied.\n` +
            `Try again with the permissions that installed it, e.g. sudo rm ${targets.join(' ')}`
        )
      }
      throw err
    }
  }

  return removed
}
