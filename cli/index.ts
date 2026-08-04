#!/usr/bin/env node
import { parseCliArgs, UsageError } from './args.js'
import { ASSETS } from './assets.generated.js'
import { openBrowser } from './open.js'
import { programName } from './programName.js'
import { ResolveError, resolveWorkspace } from './resolve.js'
import { startServer } from './server.js'
import { watchWorkspace } from './watch.js'
import { Workspace } from './workspace.js'

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2))
  const descriptor = await resolveWorkspace(options)
  const workspace = new Workspace(descriptor)

  // The bundle is embedded at build time, so this can only fail if the embed step
  // was skipped — not if a directory went missing at runtime.
  if (!ASSETS.has('index.html')) {
    throw new ResolveError('app bundle missing from this build. Run `pnpm build:cli`.')
  }

  let server: Awaited<ReturnType<typeof startServer>>
  try {
    server = await startServer({ workspace, port: options.port })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new ResolveError(
        `port ${options.port} is already in use. Omit --port to let the OS pick a free one.`
      )
    }
    throw err
  }

  const stopWatching = watchWorkspace(workspace.root, (event) => server.notify(event))

  process.stdout.write(`${programName()} serving ${workspace.root}\n`)
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
          `${programName()}: shutdown error: ${err instanceof Error ? err.message : String(err)}\n`
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
  process.stderr.write(`${programName()}: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
