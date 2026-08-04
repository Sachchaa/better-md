#!/usr/bin/env node
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCliArgs, UsageError } from './args.js'
import { openBrowser } from './open.js'
import { ResolveError, resolveWorkspace } from './resolve.js'
import { startServer } from './server.js'
import { watchWorkspace } from './watch.js'
import { Workspace } from './workspace.js'

/** dist-cli/index.js → repo root → dist/ */
function findDistDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2))
  const descriptor = await resolveWorkspace(options)
  const workspace = new Workspace(descriptor)

  const distDir = findDistDir()
  try {
    await fsp.access(path.join(distDir, 'index.html'))
  } catch {
    throw new ResolveError(`app bundle not found at ${distDir}. Run \`pnpm build\` first.`)
  }

  let server: Awaited<ReturnType<typeof startServer>>
  try {
    server = await startServer({ workspace, distDir, port: options.port })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new ResolveError(
        `port ${options.port} is already in use. Omit --port to let the OS pick a free one.`
      )
    }
    throw err
  }

  const stopWatching = watchWorkspace(workspace.root, (event) => server.notify(event))

  process.stdout.write(`better-md serving ${workspace.root}\n`)
  process.stdout.write(`  ${server.url}\n`)
  process.stdout.write('  Ctrl-C to stop\n')

  if (options.open) openBrowser(server.url)

  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    stopWatching()
    // Exit 0 either way. An unhandled rejection here would print a stack trace on
    // Ctrl-C, which is exactly what this CLI's error contract forbids.
    void server
      .close()
      .catch((err: unknown) => {
        process.stderr.write(
          `better-md: shutdown error: ${err instanceof Error ? err.message : String(err)}\n`
        )
      })
      .finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err: unknown) => {
  if (err instanceof UsageError || err instanceof ResolveError) {
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  }
  process.stderr.write(`better-md: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
