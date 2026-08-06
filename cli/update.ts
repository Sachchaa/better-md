/**
 * Checking for and applying updates.
 *
 * Both are explicit user actions — `--check-updates` and `update`. Nothing here
 * runs on startup: the tool advertises that it works entirely on your machine, so
 * a background version ping would contradict the thing it promises. The only
 * network traffic better-md ever makes is the request you asked for.
 *
 * The download path deliberately mirrors install.sh, including refusing to
 * install anything whose SHA-256 does not match the published SHA256SUMS.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assetName, isNewer } from './version.js'

const REPO = 'Sachchaa/better-md'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const LATEST_DOWNLOAD = `https://github.com/${REPO}/releases/latest/download`

/** Injected in tests; defaults to the global fetch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export class UpdateError extends Error {}

export interface UpdateCheck {
  current: string
  latest: string
  newer: boolean
}

/**
 * Ask GitHub for the latest release tag.
 *
 * A User-Agent is required by the GitHub API; without one the request is refused.
 */
export async function latestVersion(fetchImpl: FetchLike = fetch): Promise<string> {
  let res: Response
  try {
    res = await fetchImpl(LATEST_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'better-md' },
    })
  } catch (err) {
    throw new UpdateError(
      `could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (res.status === 403 || res.status === 429) {
    throw new UpdateError(
      'GitHub rate-limited this check. Try again later, or see ' +
        `https://github.com/${REPO}/releases`
    )
  }
  if (!res.ok) {
    throw new UpdateError(`GitHub answered ${res.status} for the latest release`)
  }
  const body = (await res.json()) as { tag_name?: unknown }
  if (typeof body.tag_name !== 'string' || body.tag_name === '') {
    throw new UpdateError('the latest release has no tag name')
  }
  return body.tag_name
}

export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: FetchLike = fetch
): Promise<UpdateCheck> {
  const latest = await latestVersion(fetchImpl)
  return { current: currentVersion, latest, newer: isNewer(latest, currentVersion) }
}

/** Human-readable result of a check, shared by --check-updates and update. */
export function describeCheck(check: UpdateCheck, programName: string): string {
  if (check.newer) {
    return (
      `${programName} ${check.current} is out of date — ${check.latest} is available.\n` +
      `Run \`${programName} update\` to upgrade.`
    )
  }
  return `${programName} ${check.current} is up to date.`
}

export interface SelfUpdateOptions {
  currentVersion: string
  /** Absolute path of the running executable, or null when not a packaged build. */
  executable: string | null
  platform: string
  arch: string
  fetchImpl?: FetchLike
  log: (message: string) => void
}

/**
 * Download the latest release and replace the running executable with it.
 *
 * Ordering matters and is the same as install.sh's: download, fetch the checksum
 * list, verify, and only then touch anything on disk. The replacement itself is a
 * rename within the install directory, which is atomic on the same filesystem —
 * an interrupted update therefore leaves the old working binary rather than a
 * half-written one. Replacing a running executable this way is safe on macOS and
 * Linux: the running process keeps its open inode.
 */
export async function selfUpdate(options: SelfUpdateOptions): Promise<string> {
  const { currentVersion, executable, platform, arch, log } = options
  const fetchImpl = options.fetchImpl ?? fetch

  if (executable === null) {
    throw new UpdateError(
      'this is not an installed build, so there is nothing to replace.\n' +
        'Running from a checkout? Use `git pull && pnpm build && pnpm build:cli` instead.'
    )
  }

  const asset = assetName(platform, arch)
  if (asset === null) {
    throw new UpdateError(
      `no prebuilt binary for ${platform}/${arch}. Prebuilt builds cover macOS and Linux, arm64 and x64.`
    )
  }

  const check = await checkForUpdate(currentVersion, fetchImpl)
  if (!check.newer) {
    return `already on the latest version (${currentVersion})`
  }

  log(`downloading ${check.latest}…`)
  const binary = await getBytes(`${LATEST_DOWNLOAD}/${asset}`, fetchImpl)
  const sums = new TextDecoder().decode(await getBytes(`${LATEST_DOWNLOAD}/SHA256SUMS`, fetchImpl))

  const expected = findChecksum(sums, asset)
  if (expected === null) {
    throw new UpdateError(`SHA256SUMS has no entry for ${asset}. Refusing to install unverified.`)
  }
  const actual = createHash('sha256').update(binary).digest('hex')
  if (actual !== expected) {
    throw new UpdateError(
      `checksum mismatch for ${asset} — refusing to install.\n  expected ${expected}\n  actual   ${actual}`
    )
  }
  log('checksum verified')

  // Staged beside the target so the rename stays on one filesystem.
  const dir = path.dirname(executable)
  const staged = path.join(dir, `.${path.basename(executable)}.update-${process.pid}`)
  try {
    await fs.writeFile(staged, binary, { mode: 0o755 })
    await fs.rename(staged, executable)
  } catch (err) {
    await fs.rm(staged, { force: true })
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new UpdateError(
        `cannot write to ${dir}. Re-run with the permissions that installed it, ` +
          'or reinstall with `curl -fsSL https://better-md.dev/install.sh | sh`.'
      )
    }
    throw err
  }

  return `updated ${currentVersion} -> ${check.latest}`
}

async function getBytes(url: string, fetchImpl: FetchLike): Promise<Buffer> {
  let res: Response
  try {
    res = await fetchImpl(url, { headers: { 'user-agent': 'better-md' } })
  } catch (err) {
    throw new UpdateError(
      `could not download ${url}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!res.ok) throw new UpdateError(`could not download ${url} (HTTP ${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Pull one asset's checksum out of a SHA256SUMS file.
 *
 * Matched on the exact filename rather than a substring: `better-md-linux-x64`
 * is a prefix of nothing today, but `-arm64` vs `-arm64-musl` is the kind of
 * future asset name that would make a loose match silently verify the wrong file.
 */
export function findChecksum(sums: string, asset: string): string | null {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim())
    if (match !== null && match[2] === asset) return match[1]
  }
  return null
}
