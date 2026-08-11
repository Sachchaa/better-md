/**
 * Handing the file to the reader's own editor.
 *
 * Nothing here guesses a binary. Spawning whatever happens to be installed drops
 * someone into an editor they did not choose and may not know how to leave — vi
 * being the classic example. If neither variable is set, say so and let them
 * decide.
 */
import type { spawn as SpawnFn } from 'node:child_process'

/** What to print when no editor is configured. */
export const EDITOR_HELP = `No editor configured.

Set $EDITOR, for example:

  export EDITOR=nvim`

/**
 * The configured editor, or null.
 *
 * VISUAL wins because it is by convention the full-screen editor, while EDITOR
 * may be a line editor. An empty or blank value counts as unset: `EDITOR=` in a
 * shell profile is common and means nothing is configured.
 */
export function resolveEditor(env: NodeJS.ProcessEnv): string | null {
  for (const value of [env.VISUAL, env.EDITOR]) {
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return null
}

/** Split `code -w` into the command and its arguments. */
export function splitEditor(editor: string): { command: string; args: string[] } {
  const parts = editor.split(/\s+/).filter((p) => p !== '')
  return { command: parts[0] ?? '', args: parts.slice(1) }
}

/**
 * Run the editor on `file` and wait for it to close.
 *
 * stdio is inherited so the editor owns the terminal outright; anything else and
 * it draws into a pipe while the reader stares at a frozen screen. Returning
 * before it exits would redraw over an editor still in use.
 */
export function openInEditor(
  file: string,
  editor: string,
  spawnImpl: typeof SpawnFn
): Promise<void> {
  const { command, args } = splitEditor(editor)
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, [...args, file], { stdio: 'inherit' })
    // A non-zero exit is the editor's business, not the viewer's — `vi` exiting 1
    // must not take the viewer down. Only failing to start is an error worth
    // reporting, since then nothing happened at all.
    child.on('exit', () => resolve())
    child.on('error', (err: Error) => reject(new Error(`could not start ${command}: ${err.message}`)))
  })
}
