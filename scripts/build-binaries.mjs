/**
 * Build self-contained `better-md` executables with Node's Single Executable
 * Application support.
 *
 * Why SEA rather than `bun build --compile`: a Bun binary embeds Bun's runtime,
 * and none of this project's tests ran under it. SEA embeds the same Node 22
 * runtime the suite was verified against, so the existing tests keep meaning
 * what they say. The cost is this script — cross-compiling means fetching the
 * official Node binary for each target and injecting the payload into a copy.
 *
 * Pipeline per target:
 *   dist-cli/ (ESM, tsc output)  ──esbuild──▶  one CJS file
 *   CJS file                     ──node ──▶   SEA blob
 *   official node binary + blob  ──postject▶  better-md-<platform>-<arch>
 *
 * SEA runs its payload as CommonJS, which is why the ESM output is bundled down
 * first rather than injected directly.
 *
 * Usage:
 *   node scripts/build-binaries.mjs            # host platform only (fast)
 *   node scripts/build-binaries.mjs --all      # every target
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'release')
const WORK = path.join(ROOT, 'build')
const CACHE = path.join(WORK, 'node-cache')

const NODE_VERSION = process.version.replace(/^v/, '')
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

/** `bin/node` inside each official archive, and how to unpack it. */
const TARGETS = [
  { platform: 'darwin', arch: 'arm64', ext: 'tar.gz' },
  { platform: 'darwin', arch: 'x64', ext: 'tar.gz' },
  { platform: 'linux', arch: 'x64', ext: 'tar.xz' },
  { platform: 'linux', arch: 'arm64', ext: 'tar.xz' },
]

const wanted = process.argv.includes('--all')
  ? TARGETS
  : TARGETS.filter((t) => t.platform === process.platform && t.arch === process.arch)

if (wanted.length === 0) {
  throw new Error(`no target matches this host (${process.platform}-${process.arch})`)
}

async function sha256(file) {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex')
}

/** Official checksums, so a tampered or truncated download cannot be injected into. */
async function officialChecksums() {
  const res = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`)
  if (!res.ok) throw new Error(`could not fetch SHASUMS256.txt (${res.status})`)
  const map = new Map()
  for (const line of (await res.text()).split('\n')) {
    const [hash, name] = line.trim().split(/\s+/)
    if (hash && name) map.set(name, hash)
  }
  return map
}

/** Download (and cache) the official node binary for a target, verifying its hash. */
async function nodeBinaryFor(target, checksums) {
  const base = `node-v${NODE_VERSION}-${target.platform}-${target.arch}`
  const archive = `${base}.${target.ext}`
  const cached = path.join(CACHE, base, 'node')
  if (
    await fs.stat(cached).then(
      () => true,
      () => false
    )
  )
    return cached

  const expected = checksums.get(archive)
  if (expected === undefined) throw new Error(`no published checksum for ${archive}`)

  await fs.mkdir(CACHE, { recursive: true })
  const tarball = path.join(CACHE, archive)
  process.stdout.write(`  fetching ${archive}\n`)
  const res = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${archive}`)
  if (!res.ok) throw new Error(`download failed for ${archive} (${res.status})`)
  await fs.writeFile(tarball, Buffer.from(await res.arrayBuffer()))

  const actual = await sha256(tarball)
  if (actual !== expected) {
    await fs.rm(tarball, { force: true })
    throw new Error(
      `checksum mismatch for ${archive}\n  expected ${expected}\n  got      ${actual}`
    )
  }

  // Extract only bin/node; the rest of the distribution is not needed.
  await fs.mkdir(path.join(CACHE, base), { recursive: true })
  execFileSync('tar', ['-xf', tarball, '-C', CACHE, `${base}/bin/node`], { stdio: 'inherit' })
  await fs.rename(path.join(CACHE, base, 'bin', 'node'), cached)
  await fs.rm(path.join(CACHE, base, 'bin'), { recursive: true, force: true })
  await fs.rm(tarball, { force: true })
  return cached
}

await fs.rm(WORK, { recursive: true, force: true }).catch(() => {})
await fs.mkdir(WORK, { recursive: true })
await fs.mkdir(OUT, { recursive: true })

// 1. Bundle the compiled ESM CLI into a single CommonJS file for SEA.
const entry = path.join(ROOT, 'dist-cli', 'index.js')
if (
  !(await fs.stat(entry).then(
    () => true,
    () => false
  ))
) {
  throw new Error('dist-cli/index.js missing — run `pnpm build:cli` first')
}
const bundle = path.join(WORK, 'better-md.cjs')
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  target: `node${NODE_VERSION.split('.')[0]}`,
  format: 'cjs',
  // Keep node builtins external; everything of ours is inlined, including the
  // generated asset module, which is what makes the binary self-contained.
  banner: { js: '/* better-md — generated bundle, do not edit */' },
  legalComments: 'none',
  logLevel: 'warning',
})
process.stdout.write(
  `bundled -> ${path.relative(ROOT, bundle)} (${(await fs.stat(bundle)).size} bytes)\n`
)

// 2. Build the SEA blob once; it is platform independent.
const seaConfig = path.join(WORK, 'sea-config.json')
const blob = path.join(WORK, 'better-md.blob')
await fs.writeFile(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2)
)
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' })

// 3. Inject into a copy of each target's official node binary.
const checksums = await officialChecksums()
const produced = []
for (const target of wanted) {
  const name = `better-md-${target.platform}-${target.arch}`
  process.stdout.write(`\n${name}\n`)
  const source = await nodeBinaryFor(target, checksums)
  const outFile = path.join(OUT, name)
  await fs.copyFile(source, outFile)
  await fs.chmod(outFile, 0o755)

  // A signed macOS binary must have its signature removed before the payload is
  // appended, then be re-signed, or the loader refuses to run it.
  const isDarwin = target.platform === 'darwin'
  if (isDarwin && process.platform === 'darwin') {
    execFileSync('codesign', ['--remove-signature', outFile], { stdio: 'ignore' })
  }

  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
      outFile,
      'NODE_SEA_BLOB',
      blob,
      '--sentinel-fuse',
      FUSE,
      ...(isDarwin ? ['--macho-segment-name', 'NODE_SEA'] : []),
    ],
    { stdio: 'inherit' }
  )

  if (isDarwin && process.platform === 'darwin') {
    execFileSync('codesign', ['--sign', '-', outFile], { stdio: 'ignore' })
  }

  produced.push({ name, size: (await fs.stat(outFile)).size, sha256: await sha256(outFile) })
  process.stdout.write(`  ${name}  ${(produced.at(-1).size / 1024 / 1024).toFixed(1)} MiB\n`)
}

// 4. Checksums, so install.sh can verify what it downloaded.
const sums = produced.map((p) => `${p.sha256}  ${p.name}`).join('\n')
await fs.writeFile(path.join(OUT, 'SHA256SUMS'), `${sums}\n`)

process.stdout.write(`\nrelease/ contains ${produced.length} binary(ies) + SHA256SUMS\n`)
process.stdout.write(`node runtime: v${NODE_VERSION} (${os.platform()}-${os.arch()} host)\n`)
