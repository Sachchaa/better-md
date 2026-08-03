import { parseArgs } from 'node:util'
import type { CliOptions } from './types.js'

/** Thrown for any bad invocation, and for --help (message is the usage text). */
export class UsageError extends Error {}

export const USAGE = `better-md — open markdown files from disk in the better-md editor

Usage:
  better-md <file.md>        open a single file
  better-md <directory>      open every markdown file in a directory
  better-md --plan           open Claude Code's plans (~/.claude/plans)

Options:
  --port <n>   listen on a specific port (default: an ephemeral port)
  --no-open    print the URL instead of opening a browser
  --help       show this message`

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

  if (values.help) throw new UsageError(USAGE)

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
    port: values.port === undefined ? 0 : parsePort(values.port),
    open: values['no-open'] !== true,
  }
}
