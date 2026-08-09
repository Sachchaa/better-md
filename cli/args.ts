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
  return `${name} — review your coding agent's plans in a real editor

Usage:
  ${name} --plan           your agent's plans, whichever wrote most recently
  ${name} <file.md>        a single file
  ${name} <directory>      every markdown file in a directory
  ${name} update           replace this binary with the latest release
  ${name} uninstall        remove better-md and its btr-md alias
  ${name} init claude      preview a Claude Code hook for each finished plan

Options:
  --agent <id>      which agent's plans --plan opens (claude, cursor)
  --detach          start in the background, print the URL and return
  --write           let init modify the agent's config (default: preview only)
  --port <n>        listen on a specific port (default: 8080, or a free port if taken)
  --no-open         print the URL instead of opening a browser
  --check-updates   ask GitHub whether a newer release exists
  --version         print the version
  --help            show this message

To open a file or directory literally named "update" or "uninstall", prefix it
with ./ — for example ./update.`
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
  // A bare invocation is almost always someone finding their way in, so answer
  // with the help rather than an error. Deliberately only the *empty* case:
  // flags without a target (`--no-open`) are a mistake, and replacing that
  // message with help would hide it.
  if (argv.length === 0) throw new InfoRequest(usage())

  let values: {
    plan?: boolean
    port?: string
    'no-open'?: boolean
    help?: boolean
    version?: boolean
    'check-updates'?: boolean
    agent?: string
    detach?: boolean
    write?: boolean
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
        agent: { type: 'string' },
        detach: { type: 'boolean', default: false },
        write: { type: 'boolean', default: false },
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

  // `init <agent>` is the only form taking two positionals.
  if (positionals[0] !== 'init' && positionals.length > 1) {
    throw new UsageError(`expected at most one file or directory, got ${positionals.length}`)
  }
  const target = positionals[0] ?? null

  // A bare `update` is the subcommand, not a path. Unconditional rather than
  // "only when no such file exists", because a rule that changes with the
  // contents of the current directory is worse than one that is always true —
  // `./update` is the documented way to mean the path.
  // `remove` is accepted but not advertised: someone will type it, and a dead
  // end there is worse than an alias. `uninstall` is the documented name because
  // in a document editor "remove" reads like "delete this document".
  const command =
    target === 'update'
      ? 'update'
      : target === 'uninstall' || target === 'remove'
        ? 'uninstall'
        : target === 'init'
          ? 'init'
          : null
  const checkUpdates = values['check-updates'] === true

  // `update` and `--check-updates` do not open anything, so they take no target
  // and no --plan. Rejecting the combination beats silently ignoring half of what
  // was typed.
  if (command === 'init') {
    const which = positionals[1] ?? null
    if (which === null) throw new UsageError('init needs an agent, e.g. init claude')
    if (which !== 'claude') {
      throw new UsageError(`init does not know how to configure "${which}". Supported: claude.`)
    }
    return {
      target: null,
      plan: false,
      port: null,
      open: false,
      agent: null,
      detach: false,
      command,
      initTarget: which,
      write: values.write === true,
      checkUpdates: false,
    }
  }

  if (command !== null || checkUpdates) {
    const action = command ?? '--check-updates'
    if (values.plan === true) throw new UsageError(`${action} cannot be combined with --plan`)
    if (checkUpdates && target !== null) {
      throw new UsageError(`--check-updates cannot be combined with a file or directory argument`)
    }
    return {
      target: null,
      plan: false,
      port: null,
      open: false,
      agent: null,
      detach: false,
      command,
      initTarget: null,
      write: false,
      checkUpdates,
    }
  }

  const agent = values.agent ?? null
  // --agent only means anything alongside --plan; silently ignoring it would hide
  // a mistyped invocation that then opens the wrong thing.
  if (agent !== null && values.plan !== true) {
    throw new UsageError('--agent only applies to --plan')
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
    agent,
    detach: values.detach === true,
    command: null,
    initTarget: null,
    write: false,
    checkUpdates: false,
  }
}
