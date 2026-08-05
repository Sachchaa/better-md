import { parseArgs } from 'node:util'
import { programName } from './programName.js'
import type { CliOptions } from './types.js'

/** Thrown for any bad invocation, and for --help (message is the usage text). */
export class UsageError extends Error {}

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

Options:
  --port <n>   listen on a specific port (default: 8080, or a free port if taken)
  --no-open    print the URL instead of opening a browser
  --help       show this message`
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
  let values: { plan?: boolean; port?: string; 'no-open'?: boolean; help?: boolean }
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        plan: { type: 'boolean', default: false },
        port: { type: 'string' },
        'no-open': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err))
  }

  if (values.help) throw new UsageError(usage())

  if (positionals.length > 1) {
    throw new UsageError(`expected at most one file or directory, got ${positionals.length}`)
  }
  const target = positionals[0] ?? null

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
  }
}
