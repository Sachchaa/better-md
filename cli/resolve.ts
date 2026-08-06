import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AGENT_IDS, detectAgents, pickAgent, planSources, readPlansDirectory } from './agents.js'
import { DOC_EXTENSIONS } from './docExtensions.js'
import type { CliOptions, WorkspaceDescriptor, WorkspaceFile } from './types.js'

export { DOC_EXTENSIONS }

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

async function resolvePlans(plansDir: string, label = 'Claude Code'): Promise<WorkspaceDescriptor> {
  const hint = `No plans directory found at ${plansDir}. Is ${label} installed? Pass a file or directory instead.`
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
  plansDir?: string
): Promise<WorkspaceDescriptor> {
  if (opts.plan) {
    // An explicit directory (tests, or a future --plans-dir) skips detection.
    if (plansDir !== undefined) return resolvePlans(plansDir)
    return resolveAgentPlans(opts.agent)
  }
  if (opts.target === null) throw new ResolveError('no target to resolve')
  return resolveTarget(opts.target)
}

/**
 * Find the right agent's plans and open those.
 *
 * One agent, not all of them: a workspace has a single root, and the path
 * confinement in workspace.ts is built on that. Merging two agents' directories
 * would mean re-deriving that guarantee for multiple roots.
 */
async function resolveAgentPlans(requested: string | null): Promise<WorkspaceDescriptor> {
  const home = os.homedir()
  const cwd = process.cwd()
  const sources = planSources({ home, cwd, plansDirectory: await readPlansDirectory(home, cwd) })

  if (requested !== null && !sources.some((s) => s.id === requested)) {
    throw new ResolveError(`unknown agent "${requested}". Supported: ${AGENT_IDS.join(', ')}.`)
  }

  const found = await detectAgents(sources)
  const chosen = pickAgent(found, requested)

  if (chosen === null) {
    if (requested !== null) {
      const where = sources.find((s) => s.id === requested)?.dir ?? requested
      throw new ResolveError(`no ${requested} plans found in ${where}.`)
    }
    throw new ResolveError(
      'no agent plans found. Looked in:\n' +
        sources.map((s) => `  ${s.id.padEnd(7)} ${s.dir}`).join('\n') +
        '\nPass a file or directory instead.'
    )
  }
  return resolvePlans(chosen.dir, chosen.label)
}
