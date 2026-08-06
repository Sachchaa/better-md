/**
 * Where coding agents keep the plans they write.
 *
 * A registry rather than a flag per agent: the product is agent-agnostic, and
 * adding a tool should be one entry here rather than a new branch through argv,
 * resolution and help text.
 *
 * Only agents that actually write plan files appear. Codex is deliberately
 * absent — it keeps sessions in a sqlite log, so an adapter for it could never
 * resolve to anything, and a flag that always fails is worse than no flag.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { DOC_EXTENSIONS } from './docExtensions.js'

export const AGENT_IDS = ['claude', 'cursor'] as const
export type AgentId = (typeof AGENT_IDS)[number]

export interface PlanSource {
  id: AgentId
  label: string
  dir: string
}

export interface DetectedAgent extends PlanSource {
  /** How many documents the directory holds. */
  count: number
  /** mtime of the most recent one, for picking a default. */
  newestMtimeMs: number
}

export interface PlanSourceOptions {
  home: string
  cwd: string
  /**
   * Claude Code's `plansDirectory` setting, when set. Its schema documents it as
   * "relative to project root", so it is resolved against cwd; an absolute path
   * is taken as given.
   */
  plansDirectory?: string | null
}

export function planSources(options: PlanSourceOptions): PlanSource[] {
  const { home, cwd } = options
  const configured = options.plansDirectory
  const claudeDir =
    configured === undefined || configured === null || configured === ''
      ? path.join(home, '.claude', 'plans')
      : path.resolve(cwd, configured)

  return [
    { id: 'claude', label: 'Claude Code', dir: claudeDir },
    { id: 'cursor', label: 'Cursor', dir: path.join(home, '.cursor', 'plans') },
  ]
}

function isDoc(name: string): boolean {
  return (DOC_EXTENSIONS as readonly string[]).includes(path.extname(name).toLowerCase())
}

/**
 * Which of `sources` actually hold plans right now.
 *
 * A directory that exists but is empty is not reported: it would resolve to an
 * empty workspace, which looks like a bug rather than an absent agent.
 */
export async function detectAgents(sources: PlanSource[]): Promise<DetectedAgent[]> {
  const found: DetectedAgent[] = []
  for (const source of sources) {
    let names: string[]
    try {
      names = (await fs.readdir(source.dir, { withFileTypes: true }))
        .filter((e) => (e.isFile() || e.isSymbolicLink()) && isDoc(e.name))
        .map((e) => e.name)
    } catch {
      continue // no such directory: this agent is simply not installed
    }
    if (names.length === 0) continue

    let newest = 0
    for (const name of names) {
      try {
        const { mtimeMs } = await fs.stat(path.join(source.dir, name))
        if (mtimeMs > newest) newest = mtimeMs
      } catch {
        // Raced away between readdir and stat; the others still count.
      }
    }
    found.push({ ...source, count: names.length, newestMtimeMs: newest })
  }
  return found
}

/**
 * Choose which agent's plans to open.
 *
 * With no explicit request, the one that wrote most recently — which makes a
 * bare `--plan` mean "the plan I was just looking at", whichever tool produced
 * it. One agent, not all of them: a workspace has a single root, and that is
 * what the path-confinement guarantee in workspace.ts is built on.
 */
export function pickAgent(found: DetectedAgent[], requested: string | null): DetectedAgent | null {
  if (requested !== null) return found.find((f) => f.id === requested) ?? null
  return found.reduce<DetectedAgent | null>(
    (best, f) => (best === null || f.newestMtimeMs > best.newestMtimeMs ? f : best),
    null
  )
}

/** Read Claude Code's plansDirectory, preferring a project setting over the user one. */
export async function readPlansDirectory(home: string, cwd: string): Promise<string | null> {
  for (const file of [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.json'),
  ]) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { plansDirectory?: unknown }
      if (typeof parsed.plansDirectory === 'string' && parsed.plansDirectory !== '') {
        return parsed.plansDirectory
      }
    } catch {
      // Missing or unparseable: fall through. A broken settings file must not
      // stop --plan from working against the default location.
    }
  }
  return null
}
