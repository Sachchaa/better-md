import path from 'node:path'

/** The bin shims this package installs — keep in sync with package.json "bin". */
const BIN_NAMES = new Set(['better-md', 'btr-md'])

/** Used when we cannot tell how we were invoked. */
export const CANONICAL_NAME = 'better-md'

/**
 * The name this process was invoked as.
 *
 * The package installs two shims pointing at the same entry point, so a user who
 * typed `better-md --help` should not be told about `btr-md`, and vice versa.
 * Deriving the name means help text and error prefixes always match what was
 * actually typed, instead of one alias advertising the other.
 *
 * Only recognised shim names are echoed back. A direct `node dist-cli/index.js`
 * has `argv[1]` of `index.js`, which says nothing about intent, so that falls
 * back to the canonical name rather than printing `index`.
 */
export function programName(argv1: string | undefined = process.argv[1]): string {
  const base = path.basename(argv1 ?? '').replace(/\.[cm]?js$/, '')
  return BIN_NAMES.has(base) ? base : CANONICAL_NAME
}
