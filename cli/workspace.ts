import fs from 'node:fs/promises'
import path from 'node:path'
import { DOC_EXTENSIONS } from './resolve.js'
import type { WorkspaceDescriptor, WorkspaceFile } from './types.js'

/** Thrown when a requested path is not a plain document inside the root. */
export class PathError extends Error {}

/** Thrown when the on-disk state no longer matches what the client loaded. */
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly mtimeMs: number
  ) {
    super(message)
  }
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
    const rel = path.relative(this.root, abs)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new PathError('path escapes the workspace root')
    }
    return abs
  }

  /** Syntactic validation plus symlink resolution against the real root. */
  private async confineReal(relPath: string): Promise<string> {
    const abs = this.confine(relPath)
    let real: string
    try {
      real = await fs.realpath(abs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Not yet on disk. confine() already proved it is directly under root.
        return abs
      }
      throw err
    }
    const realRoot = await fs.realpath(this.root)
    const rel = path.relative(realRoot, real)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new PathError('resolved path escapes the workspace root')
    }
    return abs
  }

  async read(relPath: string): Promise<DocRead> {
    const abs = await this.confineReal(relPath)
    const [content, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)])
    return { relPath, content, mtimeMs: stat.mtimeMs }
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
      throw new ConflictError('file no longer exists on disk', 0)
    }
    if (baseMtimeMs !== null && current !== null && Math.abs(current - baseMtimeMs) > 1) {
      throw new ConflictError('file changed on disk since it was loaded', current)
    }

    await fs.writeFile(abs, content, 'utf8')
    return { mtimeMs: (await fs.stat(abs)).mtimeMs }
  }
}
