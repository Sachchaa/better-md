#!/usr/bin/env node
import sea from 'node:sea'
import { InfoRequest, parseCliArgs, UsageError } from './args.js'
import { ASSETS } from './assets.generated.js'
import { openBrowser } from './open.js'
import { programName } from './programName.js'
import { ResolveError, resolveWorkspace } from './resolve.js'
import { startServer } from './server.js'
import { checkForUpdate, describeCheck, selfUpdate, UpdateError } from './update.js'
import { uninstall, UninstallError } from './uninstall.js'
import { VERSION } from './version.generated.js'
import { watchWorkspace } from './watch.js'
import { Workspace } from './workspace.js'

/**
 * The running executable, or null when this is not a packaged build.
 *
 * `sea.isSea()` is the authoritative answer — a renamed binary still reports true,
 * and `node dist-cli/index.js` still reports false, which a basename check of
 * process.execPath gets wrong in both directions.
 */
function packagedExecutable(): string | null {
  return sea.isSea() ? process.execPath : null
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2))

  if (options.checkUpdates) {
    const check = await checkForUpdate(VERSION)
    process.stdout.write(`${describeCheck(check, programName())}\n`)
    return
  }

  if (options.command === 'uninstall') {
    const removed = await uninstall({
      executable: packagedExecutable(),
      log: (message) => process.stdout.write(`${message}\n`),
    })
    for (const file of removed) process.stdout.write(`removed ${file}\n`)
    process.stdout.write('better-md is gone. Nothing else was left on disk.\n')
    return
  }

  if (options.command === 'update') {
    const result = await selfUpdate({
      currentVersion: VERSION,
      executable: packagedExecutable(),
      platform: process.platform,
      arch: process.arch,
      log: (message) => process.stdout.write(`${message}\n`),
    })
    process.stdout.write(`${result}\n`)
    return
  }

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
      // Only reachable for an explicit --port; the default falls back on its own.
      throw new ResolveError(
        `port ${options.port} is already in use. Omit --port to pick a free one automatically.`
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
  // Asked-for output goes to stdout and exits 0, so it can be piped and scripted.
  if (err instanceof InfoRequest) {
    process.stdout.write(`${err.message}\n`)
    process.exit(0)
  }
  if (err instanceof UpdateError || err instanceof UninstallError) {
    process.stderr.write(`${programName()}: ${err.message}\n`)
    process.exit(1)
  }
  if (err instanceof UsageError || err instanceof ResolveError) {
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  }
  process.stderr.write(`${programName()}: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
