import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CliOptions, WorkspaceDescriptor, WorkspaceFile } from './types.js'

/** Extensions treated as editable documents. Lowercase, dot-prefixed. */
export const DOC_EXTENSIONS = ['.md', '.markdown', '.txt'] as const

export const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans')

/** Thrown when the requested target cannot become a usable workspace. */
export class ResolveError extends Error {}

function isDoc(name: string): boolean {
  const ext = path.extname(name).toLowerCase()
  return (DOC_EXTENSIONS as readonly string[]).includes(ext)
}

async function listDocs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && isDoc(e.name))
    .map((e) => e.name)
}

function toFiles(names: string[]): WorkspaceFile[] {
  return names.map((name) => ({ name, relPath: name }))
}

async function newestByMtime(dir: string, names: string[]): Promise<string> {
  const stats = await Promise.all(
    names.map(async (name) => ({ name, mtimeMs: (await fs.stat(path.join(dir, name))).mtimeMs }))
  )
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
  return stats[0].name
}

async function resolvePlans(plansDir: string): Promise<WorkspaceDescriptor> {
  const hint = `No plans directory found at ${plansDir}. Is Claude Code installed? Pass a file or directory instead.`
  let names: string[]
  try {
    names = await listDocs(plansDir)
  } catch {
    throw new ResolveError(hint)
  }
  if (names.length === 0) throw new ResolveError(hint)

  const root = await fs.realpath(plansDir)
  return { root, files: toFiles(names.sort()), active: await newestByMtime(root, names) }
}

async function resolveTarget(target: string): Promise<WorkspaceDescriptor> {
  const abs = path.resolve(target)
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(abs)
  } catch {
    throw new ResolveError(`no such file or directory: ${target}`)
  }

  if (stat.isDirectory()) {
    const names = await listDocs(abs)
    if (names.length === 0) {
      throw new ResolveError(`no ${DOC_EXTENSIONS.join(', ')} files found in ${target}`)
    }
    const sorted = names.sort()
    return { root: await fs.realpath(abs), files: toFiles(sorted), active: sorted[0] }
  }

  if (!isDoc(abs)) {
    throw new ResolveError(
      `${target} is not a markdown file (expected one of ${DOC_EXTENSIONS.join(', ')})`
    )
  }
  const name = path.basename(abs)
  return {
    root: await fs.realpath(path.dirname(abs)),
    files: toFiles([name]),
    active: name,
  }
}

export async function resolveWorkspace(
  opts: CliOptions,
  plansDir: string = PLANS_DIR
): Promise<WorkspaceDescriptor> {
  if (opts.plan) return resolvePlans(plansDir)
  if (opts.target === null) throw new ResolveError('no target to resolve')
  return resolveTarget(opts.target)
}
