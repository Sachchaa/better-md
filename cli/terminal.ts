/**
 * Terminal mode's entry point: build the app from real process handles and hold
 * the terminal until the reader quits.
 *
 * The process-level wiring lives here rather than in `terminal/app.ts` so the app
 * itself stays free of global state and its tests need no cleanup.
 */
import { parseBlocks } from './blocks.js'
import { supportsUnicode } from './terminal/ansi.js'
import { createApp, type Tty } from './terminal/app.js'
import { renderDocument } from './terminal/render.js'
import type { WorkspaceDescriptor } from './types.js'
import { watchWorkspace } from './watch.js'
import { Workspace } from './workspace.js'

/** Assumed width when the destination reports none, as a pipe does. */
const DEFAULT_COLUMNS = 80

/**
 * Whether an interactive viewer can run at all.
 *
 * Both ends have to be a terminal. Without a tty on stdout the escape codes go
 * into a file; without one on stdin no keypress can ever arrive, so there is no
 * way to quit. Either way the viewer would hold the shell with no way out.
 */
export function canRunInteractively(
  stdout: { isTTY?: boolean },
  stdin: { isTTY?: boolean }
): boolean {
  return stdout.isTTY === true && stdin.isTTY === true
}

/**
 * Render the document once, for a pipe or a redirect.
 *
 * `better-md -t plan.md | less` and `> plan.txt` are both reasonable things to
 * type, and a one-shot plain-text render is more useful than an error.
 */
export function renderOnce(
  markdown: string,
  options: { columns: number | undefined; env: NodeJS.ProcessEnv }
): string {
  const lines = renderDocument(parseBlocks(markdown), {
    width: options.columns ?? DEFAULT_COLUMNS,
    unicode: supportsUnicode(options.env),
    // Never styled: the destination is a file or another program, where escape
    // codes are noise rather than formatting.
    colour: false,
  })
  return `${lines.map((l) => l.text).join('\n')}\n`
}

export async function runTerminal(descriptor: WorkspaceDescriptor): Promise<void> {
  const workspace = new Workspace(descriptor)
  // Through Workspace, so terminal mode cannot read a file browser mode would
  // refuse. One set of path rules, not two.
  const read = async (): Promise<string> => (await workspace.read(descriptor.active)).content

  if (!canRunInteractively(process.stdout, process.stdin)) {
    process.stdout.write(renderOnce(await read(), { columns: process.stdout.columns, env: process.env }))
    return
  }

  const app = createApp({
    file: descriptor.active,
    read,
    watch: (onChange) =>
      // The watcher reports every document in the directory; only the open one
      // matters here. A sibling plan changing must not repaint this pane.
      //
      // A removal is passed through rather than filtered out: the read that
      // follows fails, and the app says so instead of leaving a deleted file on
      // screen as though it were current.
      watchWorkspace(workspace.root, (event) => {
        if (event.relPath === descriptor.active) onChange()
      }),
    tty: process.stdout as unknown as Tty,
    input: process.stdin,
    env: process.env,
    // 130 is the conventional status for interrupted-by-Ctrl-C. Quitting with q
    // is not an interruption, so it drains normally and exits 0.
    onInterrupt: () => process.exit(130),
  })

  // Registered before start so a crash between here and the first draw still
  // restores the terminal. `stop` is idempotent, so overlapping paths are safe.
  const restore = (): void => app.stop()
  process.on('exit', restore)
  process.on('SIGINT', () => {
    restore()
    // 130 is the conventional status for terminated-by-Ctrl-C.
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    restore()
    process.exit(143)
  })

  await app.start()
}
