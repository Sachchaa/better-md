import fs from 'node:fs/promises'
import path from 'node:path'
import { DOC_EXTENSIONS } from './resolve.js'
import type { WorkspaceDescriptor, WorkspaceFile } from './types.js'

/** Thrown when a requested path is not a plain document inside the root. */
export class PathError extends Error {}

/**
 * Thrown when the on-disk state no longer matches what the client loaded.
 * `mtimeMs` is null when there is no on-disk version to report.
 */
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly mtimeMs: number | null
  ) {
    super(message)
  }
}

/**
 * Thrown when a confined path names nothing readable. Distinct from PathError so
 * the HTTP layer can answer 404 instead of turning a routine missing file into a
 * 500 by letting a raw errno escape.
 */
export class NotFoundError extends Error {}

/**
 * Thrown when a write fails for a reason the operator (not the requester) needs
 * to fix — permissions, a read-only mount, or a full disk. Distinct from
 * PathError so the HTTP layer can answer with `status` and a message naming
 * `relPath` rather than letting the raw errno escape: that message embeds the
 * absolute path on disk, which the server must never hand back to the browser.
 */
export class WriteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

/** Recognised write-failure errnos, and the safe (no-absolute-path) reason to
 * report for each. Anything else is left to escape as an unclassified error. */
const WRITE_ERRNO_REASONS: Record<string, { reason: string; status: number }> = {
  EACCES: { reason: 'permission denied', status: 403 },
  EPERM: { reason: 'operation not permitted', status: 403 },
  EROFS: { reason: 'the filesystem is read-only', status: 403 },
  ENOSPC: { reason: 'no space left on device', status: 507 },
  EDQUOT: { reason: 'disk quota exceeded', status: 507 },
}

export interface DocRead {
  relPath: string
  content: string
  mtimeMs: number
}

/**
 * The single gateway to document contents. Every path crossing this boundary is
 * validated to be a bare filename with an allowed extension that resolves,
 * after symlinks, inside `root`. `server.ts` deliberately holds no `fs` import
 * so it cannot reach around these checks.
 */
export class Workspace {
  constructor(private readonly descriptor: WorkspaceDescriptor) {}

  get root(): string {
    return this.descriptor.root
  }

  get active(): string {
    return this.descriptor.active
  }

  list(): WorkspaceFile[] {
    return this.descriptor.files.slice()
  }

  /** Syntactic validation: bare filename, allowed extension, inside root. */
  private confine(relPath: string): string {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw new PathError('path must be a non-empty string')
    }
    if (relPath.includes('\0')) {
      throw new PathError('path contains a null byte')
    }
    if (path.isAbsolute(relPath)) {
      throw new PathError('absolute paths are not allowed')
    }
    // A bare filename is the only accepted shape: no separators, no dot-segments.
    if (relPath !== path.basename(relPath)) {
      throw new PathError('only files directly inside the workspace are allowed')
    }
    if (relPath === '.' || relPath === '..') {
      throw new PathError('path must name a file')
    }
    const ext = path.extname(relPath).toLowerCase()
    if (!(DOC_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new PathError(`unsupported file type: ${ext || '(none)'}`)
    }

    const abs = path.resolve(this.root, relPath)
    if (Workspace.escapes(this.root, abs)) {
      throw new PathError('path escapes the workspace root')
    }
    return abs
  }

  /** True when `candidate` is outside `root` (or is the root itself). */
  private static escapes(root: string, candidate: string): boolean {
    const rel = path.relative(root, candidate)
    // Compare whole path segments: a bare startsWith('..') also matches the
    // legitimate filename '..md'.
    return rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)
  }

  /**
   * Syntactic validation plus symlink resolution against the real root.
   *
   * The leaf is inspected with `lstat`, never `realpath` alone. `realpath`
   * reports ENOENT both for "nothing here" and for "a symlink whose target is
   * missing", and conflating those let a dangling symlink inside the root pass
   * validation — after which `writeFile` followed the link and created a file
   * at an arbitrary absolute path outside the workspace. `lstat` distinguishes
   * the two cases, so a symlink is always resolved and range-checked, and an
   * unresolvable one is refused rather than written through.
   */
  private async confineReal(relPath: string): Promise<string> {
    const abs = this.confine(relPath)
    const realRoot = await fs.realpath(this.root)

    let leaf: Awaited<ReturnType<typeof fs.lstat>>
    try {
      leaf = await fs.lstat(abs)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // Genuinely absent — no link to follow. confine() already proved this
        // path sits directly under the root, so creating it here is safe.
        return abs
      }
      // Any other errno here is a property of the requested name (ENAMETOOLONG,
      // ENOTDIR, EACCES...). Those are bad-request conditions, not server faults,
      // and an over-long filename is reachable from a plain HTTP request.
      throw new PathError(`cannot inspect path: ${code ?? 'unknown error'}`)
    }

    if (leaf.isSymbolicLink()) {
      let real: string
      try {
        real = await fs.realpath(abs)
      } catch {
        throw new PathError('path is a symlink whose target cannot be resolved')
      }
      if (Workspace.escapes(realRoot, real)) {
        throw new PathError('resolved path escapes the workspace root')
      }
      // The resolved target gets the same scrutiny as a direct leaf. Without this
      // an in-root symlink launders every check that follows: pointing it at a
      // directory yields a raw EISDIR, at a FIFO makes open() block forever and
      // burn a libuv threadpool thread, and at `payload.sh` defeats the
      // extension allowlist while staying inside the root.
      const targetExt = path.extname(real).toLowerCase()
      if (!(DOC_EXTENSIONS as readonly string[]).includes(targetExt)) {
        throw new PathError('symlink target is not a supported file type')
      }
      if (!(await fs.stat(real)).isFile()) {
        throw new PathError('symlink target is not a regular file')
      }
      // Return the resolved path so later syscalls do not re-traverse the link.
      return real
    }

    if (!leaf.isFile()) {
      throw new PathError('path is not a regular file')
    }

    return abs
  }

  async read(relPath: string): Promise<DocRead> {
    const abs = await this.confineReal(relPath)
    // Read content and mtime through one descriptor so they describe the same
    // version of the file. Two independent path-based syscalls can straddle an
    // external write, pairing stale content with a fresh mtime — after which the
    // client's next save passes the base-mtime check and silently discards that
    // write. This is not fully atomic (readFile is several reads and stat is a
    // separate fstat), but it does pin the inode, so a rename-replace writer can
    // no longer produce a mismatched pair.
    let handle: Awaited<ReturnType<typeof fs.open>>
    try {
      handle = await fs.open(abs, 'r')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // ENOENT is the only expected failure: confineReal has already proved the
      // leaf is a regular file, so EISDIR cannot reach here. Anything else is a
      // property of the request (EACCES on a mode-000 file), not a server fault.
      if (code === 'ENOENT') throw new NotFoundError(`no such document: ${relPath}`)
      throw new PathError(`cannot open document: ${code ?? 'unknown error'}`)
    }
    try {
      const [content, stat] = await Promise.all([handle.readFile('utf8'), handle.stat()])
      return { relPath, content, mtimeMs: stat.mtimeMs }
    } finally {
      await handle.close()
    }
  }

  /**
   * Write `content`, refusing when disk has moved since the client loaded it.
   * `baseMtimeMs === null` means "this should be a new file".
   */
  async write(
    relPath: string,
    content: string,
    baseMtimeMs: number | null
  ): Promise<{ mtimeMs: number }> {
    // Guard the base mtime before any comparison. Every check below is a
    // positive comparison, and NaN makes all of them false — so a NaN or
    // non-numeric base would fall straight through to writeFile and silently
    // clobber the file this mechanism exists to protect. The HTTP layer coerces
    // this value out of a JSON body, so a bad value is reachable, not theoretical.
    if (baseMtimeMs !== null && !Number.isFinite(baseMtimeMs)) {
      throw new PathError('baseMtimeMs must be null or a finite number')
    }

    const abs = await this.confineReal(relPath)

    let current: number | null = null
    try {
      current = (await fs.stat(abs)).mtimeMs
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    if (baseMtimeMs === null && current !== null) {
      throw new ConflictError('file already exists on disk', current)
    }
    if (baseMtimeMs !== null && current === null) {
      throw new ConflictError('file no longer exists on disk', null)
    }
    if (baseMtimeMs !== null && current !== null && current !== baseMtimeMs) {
      throw new ConflictError('file changed on disk since it was loaded', current)
    }

    try {
      await fs.writeFile(abs, content, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const mapped = code !== undefined ? WRITE_ERRNO_REASONS[code] : undefined
      // A read-only file, read-only mount, or full disk must reach the user as
      // something they can act on, not a generic "internal server error" — but
      // the raw errno message embeds the absolute path on disk, which the server
      // must never hand back to a browser. relPath (client-supplied, already
      // validated above) is the only path-like detail this message may carry.
      // The original error rides along as `cause` so the operator's own log —
      // which is not a security boundary — can still show the real path.
      if (mapped !== undefined) {
        throw new WriteError(`could not save ${relPath}: ${mapped.reason}`, mapped.status, {
          cause: err,
        })
      }
      throw err
    }
    return { mtimeMs: (await fs.stat(abs)).mtimeMs }
  }
}
