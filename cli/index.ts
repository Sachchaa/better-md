#!/usr/bin/env node
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import sea from 'node:sea'
import { InfoRequest, parseCliArgs, UsageError } from './args.js'
import { ASSETS } from './assets.generated.js'
import { openBrowser } from './open.js'
import { programName } from './programName.js'
import { ResolveError, resolveWorkspace } from './resolve.js'
import { startServer } from './server.js'
import { checkForUpdate, describeCheck, selfUpdate, UpdateError } from './update.js'
import { initClaude, InitError } from './initAgent.js'
import {
  readSession,
  removeSession,
  removeSessionSync,
  sessionFile,
  sessionIsLive,
  writeSession,
} from './session.js'
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

  if (options.command === 'init') {
    const result = await initClaude({
      home: os.homedir(),
      program: programName(),
      write: options.write,
    })
    if (!result.changed) {
      process.stdout.write(`${result.file} already has the hook — nothing to do.\n`)
      return
    }
    if (result.written) {
      process.stdout.write(
        `Added to ${result.file}:\n\n${result.block}\n\n` +
          'Claude Code will open each finished plan automatically.\n' +
          'Open /hooks once (or restart) so it picks up the change.\n'
      )
      return
    }
    process.stdout.write(
      `Would add to ${result.file}:\n\n${result.block}\n\n` + `Re-run with --write to apply it.\n`
    )
    return
  }

  if (options.command === 'uninstall') {
    const removed = await uninstall({
      executable: packagedExecutable(),
      stateDir: path.join(os.homedir(), '.better-md'),
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

  const session = sessionFile(os.homedir(), descriptor.root)

  if (options.detach) {
    await runDetached(session, options.open)
    return
  }

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

  // Only a detached run records itself. An ordinary foreground run still writes
  // nothing outside the workspace.
  const recording = process.env.BETTER_MD_SESSION
  if (recording !== undefined && recording !== '') {
    await writeSession(recording, {
      url: server.url,
      port: server.port,
      token: server.token,
      root: workspace.root,
      pid: process.pid,
    })
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
      .finally(() => {
        const file = process.env.BETTER_MD_SESSION
        if (file !== undefined && file !== '') removeSessionSync(file)
        process.exit(0)
      })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/**
 * Reuse a live server for this workspace, or start one in the background.
 *
 * Reuse matters because the intended caller is a hook that fires on every
 * finished plan: without it, each plan would leave another ~110 MB server
 * running. Liveness is proven by an authenticated request rather than a pid
 * check — ports and pids both get recycled.
 */
async function runDetached(session: string, open: boolean): Promise<void> {
  const existing = await readSession(session)
  if (existing !== null && (await sessionIsLive(existing))) {
    process.stdout.write(`${existing.url}\n`)
    if (open) openBrowser(existing.url)
    return
  }
  await removeSession(session)

  // Re-spawn self without --detach. stdio is ignored and the child unref'd, so
  // this process can exit without killing it or leaving it writing to a dead
  // pipe; the session file is the handshake instead.
  const args = process.argv.slice(2).filter((a) => a !== '--detach')
  const child = spawn(process.execPath, sea.isSea() ? args : [process.argv[1], ...args], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, BETTER_MD_SESSION: session },
  })
  child.unref()

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const record = await readSession(session)
    if (record !== null && (await sessionIsLive(record))) {
      process.stdout.write(`${record.url}\n`)
      if (open) openBrowser(record.url)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new ResolveError('the background server did not start within 15s')
}

main().catch((err: unknown) => {
  // Asked-for output goes to stdout and exits 0, so it can be piped and scripted.
  if (err instanceof InfoRequest) {
    process.stdout.write(`${err.message}\n`)
    process.exit(0)
  }
  if (err instanceof UpdateError || err instanceof UninstallError || err instanceof InitError) {
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
