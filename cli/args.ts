import { parseArgs } from 'node:util'
import { programName } from './programName.js'
import { VERSION } from './version.generated.js'
import type { CliOptions } from './types.js'

/** Thrown for any bad invocation. Printed to stderr, exit 1. */
export class UsageError extends Error {}

/**
 * Thrown when the user asked to be told something — --help, --version — rather
 * than made a mistake. Printed to STDOUT and exits 0.
 *
 * Distinct from UsageError because the two need opposite handling and used not to
 * get it: --help went out on stderr with exit 1, so `better-md --help | less`
 * showed nothing and `better-md --help && echo ok` never reached the echo.
 */
export class InfoRequest extends Error {}

/**
 * Usage text, built around the name the CLI was invoked as so the two installed
 * shims each describe themselves rather than advertising the other.
 */
export function usage(name: string = programName()): string {
  return `${name} — open markdown files from disk in the better-md editor

Usage:
  ${name} <file.md>        open a single file
  ${name} <directory>      open every markdown file in a directory
  ${name} --plan           open Claude Code's plans (~/.claude/plans)
  ${name} update           replace this binary with the latest release

Options:
  --port <n>        listen on a specific port (default: 8080, or a free port if taken)
  --no-open         print the URL instead of opening a browser
  --check-updates   ask GitHub whether a newer release exists
  --version         print the version
  --help            show this message

To open a file or directory literally named "update", write ./update.`
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`--port expects a number, got "${raw}"`)
  }
  const port = Number(raw)
  if (port < 0 || port > 65535) {
    throw new UsageError(`--port must be between 0 and 65535, got ${port}`)
  }
  return port
}

export function parseCliArgs(argv: string[]): CliOptions {
  let values: {
    plan?: boolean
    port?: string
    'no-open'?: boolean
    help?: boolean
    version?: boolean
    'check-updates'?: boolean
  }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        plan: { type: 'boolean', default: false },
        port: { type: 'string' },
        'no-open': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        'check-updates': { type: 'boolean', default: false },
      },
      allowPositionals: true,
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err))
  }

  if (values.help) throw new InfoRequest(usage())
  if (values.version === true) throw new InfoRequest(`${programName()} ${VERSION}`)

  if (positionals.length > 1) {
    throw new UsageError(`expected at most one file or directory, got ${positionals.length}`)
  }
  const target = positionals[0] ?? null

  // A bare `update` is the subcommand, not a path. Unconditional rather than
  // "only when no such file exists", because a rule that changes with the
  // contents of the current directory is worse than one that is always true —
  // `./update` is the documented way to mean the path.
  const command = target === 'update' ? 'update' : null
  const checkUpdates = values['check-updates'] === true

  // `update` and `--check-updates` do not open anything, so they take no target
  // and no --plan. Rejecting the combination beats silently ignoring half of what
  // was typed.
  if (command !== null || checkUpdates) {
    const action = command !== null ? 'update' : '--check-updates'
    if (values.plan === true) throw new UsageError(`${action} cannot be combined with --plan`)
    if (checkUpdates && target !== null) {
      throw new UsageError(`--check-updates cannot be combined with a file or directory argument`)
    }
    return { target: null, plan: false, port: null, open: false, command, checkUpdates }
  }

  if (values.plan && target !== null) {
    throw new UsageError('--plan cannot be combined with a file or directory argument')
  }
  if (!values.plan && target === null) {
    throw new UsageError('missing a file or directory argument (or pass --plan)')
  }

  return {
    target,
    plan: values.plan === true,
    // null, not 0: absent means "apply the default port policy", whereas an
    // explicit --port 0 is a request for an ephemeral port and is honoured as one.
    port: values.port === undefined ? null : parsePort(values.port),
    open: values['no-open'] !== true,
    command: null,
    checkUpdates: false,
  }
}
