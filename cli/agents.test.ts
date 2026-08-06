import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AGENT_IDS, detectAgents, planSources, pickAgent, type DetectedAgent } from './agents.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

/** A fake home with whichever agents' plan dirs are asked for. */
async function fakeHome(spec: Record<string, string[]>): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-agents-'))
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }))
  for (const [dir, names] of Object.entries(spec)) {
    const full = path.join(home, dir)
    await fs.mkdir(full, { recursive: true })
    for (const name of names) await fs.writeFile(path.join(full, name), '# plan\n', 'utf8')
  }
  return home
}

describe('planSources', () => {
  it('knows where each supported agent keeps plans', () => {
    const sources = planSources({ home: '/home/x', cwd: '/repo' })
    expect(sources.map((s) => s.id).sort()).toEqual([...AGENT_IDS].sort())
    expect(sources.find((s) => s.id === 'claude')?.dir).toBe('/home/x/.claude/plans')
    expect(sources.find((s) => s.id === 'cursor')?.dir).toBe('/home/x/.cursor/plans')
  })

  // Codex keeps sessions in a sqlite log, not plan files. Listing it would give
  // an adapter that can never resolve — worse than not offering it.
  it('does not claim to support an agent with no plan files', () => {
    expect([...AGENT_IDS]).not.toContain('codex')
  })

  it('honours Claude Code plansDirectory, resolved against the project', () => {
    // Documented in Claude Code's settings schema as "relative to project root".
    // Hardcoding ~/.claude/plans silently looks in the wrong place for anyone
    // who has set it.
    const sources = planSources({ home: '/home/x', cwd: '/repo', plansDirectory: 'docs/plans' })
    expect(sources.find((s) => s.id === 'claude')?.dir).toBe('/repo/docs/plans')
  })

  it('lets an absolute plansDirectory win outright', () => {
    const sources = planSources({ home: '/home/x', cwd: '/repo', plansDirectory: '/elsewhere' })
    expect(sources.find((s) => s.id === 'claude')?.dir).toBe('/elsewhere')
  })
})

describe('detectAgents', () => {
  it('reports only agents that have plan files', async () => {
    const home = await fakeHome({ '.claude/plans': ['a.md'] })

    const found = await detectAgents(planSources({ home, cwd: home }))

    expect(found.map((f) => f.id)).toEqual(['claude'])
    expect(found[0].count).toBe(1)
  })

  it('ignores a directory that exists but holds no documents', async () => {
    const home = await fakeHome({ '.claude/plans': [], '.cursor/plans': ['a.plan.md'] })

    const found = await detectAgents(planSources({ home, cwd: home }))

    // An empty plans directory is not a usable source; offering it would resolve
    // to an empty workspace.
    expect(found.map((f) => f.id)).toEqual(['cursor'])
  })

  it('reports the newest plan time per agent', async () => {
    const home = await fakeHome({ '.claude/plans': ['old.md', 'new.md'] })
    const dir = path.join(home, '.claude/plans')
    await fs.utimes(path.join(dir, 'old.md'), new Date(1000), new Date(1000))
    await fs.utimes(path.join(dir, 'new.md'), new Date(9_000_000), new Date(9_000_000))

    const [claude] = await detectAgents(planSources({ home, cwd: home }))

    expect(claude.newestMtimeMs).toBe(9_000_000)
  })
})

describe('pickAgent', () => {
  const claude: DetectedAgent = {
    id: 'claude',
    label: 'Claude Code',
    dir: '/c',
    count: 2,
    newestMtimeMs: 100,
  }
  const cursor: DetectedAgent = {
    id: 'cursor',
    label: 'Cursor',
    dir: '/u',
    count: 9,
    newestMtimeMs: 500,
  }

  it('picks whichever agent wrote most recently', () => {
    // This is what makes a bare --plan mean "the plan I was just looking at",
    // regardless of which tool produced it.
    expect(pickAgent([claude, cursor], null)?.id).toBe('cursor')
    expect(pickAgent([cursor, claude], null)?.id).toBe('cursor')
  })

  it('honours an explicit choice even when it is not the newest', () => {
    expect(pickAgent([claude, cursor], 'claude')?.id).toBe('claude')
  })

  it('returns null when the requested agent has no plans', () => {
    expect(pickAgent([cursor], 'claude')).toBeNull()
  })

  it('returns null when nothing was detected', () => {
    expect(pickAgent([], null)).toBeNull()
  })
})
