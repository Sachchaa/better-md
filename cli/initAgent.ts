/**
 * Install the agent-side half of the workflow.
 *
 * `better-md init claude` adds a Claude Code hook that opens the plan the moment
 * one is finished, so reviewing it is not another command to remember.
 *
 * The hook is `async` deliberately. `better-md --plan` starts a server that runs
 * until it is stopped, so a blocking hook would hang the turn that triggered it;
 * `--detach` returns immediately and reuses an existing server rather than
 * starting a second one on every plan.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export class InitError extends Error {}

export const HOOK_EVENT = 'PostToolUse'
/** Claude Code calls this tool when it finishes presenting a plan. */
export const HOOK_MATCHER = 'ExitPlanMode'

interface CommandHook {
  type: string
  command?: string
  async?: boolean
  [key: string]: unknown
}
interface HookEntry {
  matcher?: string
  hooks: CommandHook[]
  [key: string]: unknown
}
interface Settings {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

export function hookCommand(program: string): string {
  return `${program} --plan --detach`
}

export function hookEntry(program: string): HookEntry {
  return {
    matcher: HOOK_MATCHER,
    hooks: [{ type: 'command', command: hookCommand(program), async: true }],
  }
}

export function settingsPath(home: string): string {
  return path.join(home, '.claude', 'settings.json')
}

export interface InitResult {
  /** The JSON that was added, or would be added. */
  block: string
  file: string
  /** False when an identical hook was already present. */
  changed: boolean
  written: boolean
}

/**
 * Add the hook to Claude Code's settings, preserving everything already there.
 *
 * Read-merge-write, never replace: this file typically holds the user's model,
 * plugins, permissions and status line, and clobbering it to add one hook would
 * be a far worse outcome than not installing.
 */
export async function initClaude(options: {
  home: string
  program: string
  write: boolean
}): Promise<InitResult> {
  const file = settingsPath(options.home)
  const entry = hookEntry(options.program)
  const block = JSON.stringify({ hooks: { [HOOK_EVENT]: [entry] } }, null, 2)

  let settings: Settings = {}
  let raw: string | null = null
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    // No settings file yet: creating one with only our hook is correct.
  }
  if (raw !== null) {
    try {
      settings = JSON.parse(raw) as Settings
    } catch {
      // Refusing beats overwriting. A malformed settings.json disables every
      // setting in it, so silently replacing it could cost the user far more
      // than the hook is worth.
      throw new InitError(
        `${file} is not valid JSON. Fix it first — rewriting it would discard whatever is in there.`
      )
    }
  }

  const hooks = settings.hooks ?? {}
  const forEvent = hooks[HOOK_EVENT] ?? []
  const already = forEvent.some(
    (e) =>
      e.matcher === HOOK_MATCHER &&
      e.hooks.some((h) => typeof h.command === 'string' && h.command.includes('--detach'))
  )
  if (already) return { block, file, changed: false, written: false }

  if (!options.write) return { block, file, changed: true, written: false }

  settings.hooks = { ...hooks, [HOOK_EVENT]: [...forEvent, entry] }
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Written via a sibling temp file and renamed, so an interrupted write cannot
  // leave a truncated settings.json behind — which would disable every setting.
  const staged = `${file}.better-md-${process.pid}`
  try {
    await fs.writeFile(staged, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await fs.rename(staged, file)
  } catch (err) {
    await fs.rm(staged, { force: true })
    throw err
  }
  return { block, file, changed: true, written: true }
}
