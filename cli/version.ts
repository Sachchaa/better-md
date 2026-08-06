/**
 * Version parsing and release-asset naming.
 *
 * Kept free of I/O so the comparison rules — which decide whether a user is told
 * to update — are testable without a network or a filesystem.
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** e.g. 'rc.1' in 1.0.0-rc.1, or null for a final release. */
  prerelease: string | null
}

/** Parse `1.2.3`, `v1.2.3`, or `1.2.3-rc.1`. Returns null for anything else. */
export function parseVersion(raw: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    raw.trim()
  )
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  }
}

/**
 * Is `candidate` a strictly newer release than `current`?
 *
 * Returns false when either side is unparseable: an unrecognised version must not
 * be reported as an available update, because the user would be told to upgrade
 * to something we cannot reason about.
 *
 * A prerelease sorts BEFORE the same numeric version (1.0.0-rc.1 < 1.0.0), per
 * semver. Two prereleases of the same numbers are compared as strings, which is
 * imprecise for `rc.9` vs `rc.10` but never reports an older build as newer for
 * the release cadence this project has.
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (a === null || b === null) return false

  if (a.major !== b.major) return a.major > b.major
  if (a.minor !== b.minor) return a.minor > b.minor
  if (a.patch !== b.patch) return a.patch > b.patch

  // Same numbers: a final release beats a prerelease of it.
  if (a.prerelease === null && b.prerelease === null) return false
  if (a.prerelease === null) return true
  if (b.prerelease === null) return false
  return a.prerelease > b.prerelease
}

/**
 * The release asset for a platform, matching what install.sh downloads and what
 * scripts/build-binaries.mjs publishes. Returns null where no build exists.
 *
 * Always the `better-md-` prefix, even when invoked as `btr-md`: the alias is a
 * copy of the same asset, not a separate one.
 */
export function assetName(platform: string, arch: string): string | null {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null
  if (os === null || cpu === null) return null
  return `better-md-${os}-${cpu}`
}
