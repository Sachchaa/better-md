# better-md CLI Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `better-md` CLI that opens real `.md` files from disk in the existing React app, with explicit save-back, live reload on external changes, and a hardened localhost server.

**Architecture:** A standalone Node HTTP server (`cli/`) serves the prebuilt `dist/` bundle plus a small JSON API over a single workspace directory. The React app detects a per-run token in its URL and swaps its document source from in-memory samples to the API. All filesystem access funnels through one confinement-checked module.

**Tech Stack:** Node 22 (stdlib only — `node:http`, `node:fs`, `node:crypto`, `node:util`), TypeScript 5.6 strict, React 19 (existing class component), Vite 5, Vitest 2.1, Playwright (new devDependency).

Design spec: `docs/superpowers/specs/2026-08-03-cli-bridge-design.md`

## Global Constraints

- **Zero new runtime dependencies.** `dependencies` stays exactly `react` + `react-dom`. New devDependencies allowed: `@types/node`, `@playwright/test`.
- **Node ≥ 22** required (uses `parseArgs`, `fs.watch`, `crypto.timingSafeEqual`).
- **All relative imports inside `cli/` MUST use explicit `.js` extensions** (`./types.js`, not `./types`). The CLI compiles to Node ESM under `module: NodeNext`; extensionless relative imports fail at runtime.
- **Server binds `127.0.0.1` only.** Never `0.0.0.0`.
- **Never log the token** to stdout, stderr, or any file. It appears only in the URL handed to the browser.
- TypeScript `strict`, `noUnusedLocals`, `noUnusedParameters` all stay on. `pnpm lint`, `pnpm typecheck`, `pnpm test` must pass at the end of every task.
- Baseline at plan time is green: typecheck ✓, lint ✓, 22 tests passing.
- Commit after every task.

## File Structure

**Create — CLI (Node):**

| File               | Responsibility                                                                        |
| ------------------ | ------------------------------------------------------------------------------------- |
| `cli/types.ts`     | Shared CLI types: `CliOptions`, `WorkspaceFile`, `WorkspaceDescriptor`, `WatchEvent`  |
| `cli/args.ts`      | `argv` → `CliOptions`. Pure, no I/O.                                                  |
| `cli/resolve.ts`   | `CliOptions` → `WorkspaceDescriptor`. The three entry points (file / dir / `--plan`). |
| `cli/workspace.ts` | **Only module that reads or writes document contents.** All path confinement.         |
| `cli/watch.ts`     | Debounced `fs.watch` wrapper with an injectable watcher factory.                      |
| `cli/server.ts`    | `node:http` server: static assets, JSON API, SSE. No `fs` import for documents.       |
| `cli/index.ts`     | Entry point: wiring, browser open, SIGINT teardown. Has the shebang.                  |

**Create — app (browser):**

| File                         | Responsibility                                                        |
| ---------------------------- | --------------------------------------------------------------------- |
| `src/lib/docSource.ts`       | `DocSource` interface + `LocalDocSource` (today's in-memory behavior) |
| `src/lib/serverDocSource.ts` | `ServerDocSource` — talks to the CLI API, streams SSE                 |
| `src/lib/detectSource.ts`    | Boot-time choice between the two                                      |
| `src/ui/ConflictBanner.tsx`  | Conflict / save-error UI                                              |

**Create — config & tests:**
`tsconfig.cli.json`, `tsconfig.cli-test.json`, `vitest.workspace.ts`, `playwright.config.ts`, `e2e/cli-bridge.spec.ts`, plus `*.test.ts` beside each CLI and lib module.

**Modify:**

| File                    | Change                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| `src/types.ts`          | `FileDoc` gains `relPath?`; `State` gains disk-mode fields          |
| `src/main.tsx`          | Pick a source, strip the token from the URL, pass `source` to `App` |
| `src/App.tsx:9-45`      | `source` prop, async load, dirty tracking, Cmd+S, conflict state    |
| `package.json`          | `bin`, `build:cli` + `test:e2e` scripts, `engines`, devDeps         |
| `tsconfig.json`         | Add `./tsconfig.cli.json` reference                                 |
| `tsconfig.node.json:14` | `include` → `vitest.workspace.ts` instead of `vitest.config.ts`     |
| `eslint.config.js`      | Node globals for `cli/` + `e2e/`; ignore `dist-cli`                 |
| `README.md`             | CLI usage + security model                                          |

**Delete:** `vitest.config.ts` (replaced by `vitest.workspace.ts`).

---

### Task 1: CLI build target and argument parsing

Proves the riskiest integration first: that `.js`-extension imports resolve under both `tsc` emit and Vitest, and that Node-environment tests run alongside the existing jsdom ones.

**Files:**

- Create: `cli/types.ts`, `cli/args.ts`, `cli/args.test.ts`, `tsconfig.cli.json`, `tsconfig.cli-test.json`, `vitest.workspace.ts`
- Modify: `tsconfig.json`, `tsconfig.node.json`, `package.json`, `eslint.config.js`
- Delete: `vitest.config.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `CliOptions`, `WorkspaceFile`, `WorkspaceDescriptor`, `WatchEvent` (from `cli/types.ts`); `parseCliArgs(argv: string[]): CliOptions`, `UsageError`, `USAGE` (from `cli/args.ts`).

- [ ] **Step 1: Add `@types/node` and wire up the CLI build target**

```bash
pnpm add -D @types/node@^22
```

Create `tsconfig.cli.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "outDir": "./dist-cli",
    "rootDir": "./cli",
    "tsBuildInfoFile": "./tsconfig.cli.tsbuildinfo",
    "sourceMap": true,
    "skipLibCheck": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["cli/**/*.ts"],
  "exclude": ["cli/**/*.test.ts"]
}
```

`tsconfig.cli.json` excludes test files so compiled tests never land in `dist-cli/`.
That would leave `cli/**/*.test.ts` typechecked by nothing, while `src/**/*.test.ts`
already is via `tsconfig.app.json` — so `strict` and `noUnusedLocals` would silently
not apply to any CLI test. Add a typecheck-only companion, `tsconfig.cli-test.json`,
mirroring how `tsconfig.app.json` and `tsconfig.node.json` are standalone `noEmit`
projects in this repo:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "skipLibCheck": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noEmit": true
  },
  "include": ["cli/**/*.ts"]
}
```

No `exclude`, so tests are covered. Deliberately no `composite` and no `outDir`,
matching `tsconfig.app.json`/`tsconfig.node.json`, which are referenced from the root
config without `composite` and build cleanly under `tsc -b` today.

> If `tsc -b` objects to `cli/*.ts` appearing in both this project and
> `tsconfig.cli.json`, report it rather than inventing a restructure — the fix is a
> plan decision.

Add both references in `tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.cli.json" },
    { "path": "./tsconfig.cli-test.json" }
  ]
}
```

- [ ] **Step 2: Replace the Vitest config with a two-project workspace**

Delete `vitest.config.ts` and create `vitest.workspace.ts`:

```ts
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    test: {
      name: 'app',
      environment: 'jsdom',
      include: ['src/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'cli',
      environment: 'node',
      include: ['cli/**/*.test.ts'],
    },
  },
])
```

Update `tsconfig.node.json` line 14:

```json
  "include": ["vite.config.ts", "vitest.workspace.ts"]
```

- [ ] **Step 3: Teach ESLint about Node files**

In `eslint.config.js`, change the ignores entry and append a Node block as the last argument to `tseslint.config(...)`:

```js
  { ignores: ['dist', 'dist-cli'] },
```

```js
  {
    files: ['cli/**/*.ts', 'e2e/**/*.ts', 'vitest.workspace.ts', 'vite.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  }
```

- [ ] **Step 4: Add scripts, bin, and engines to `package.json`**

```json
  "bin": { "better-md": "./dist-cli/index.js" },
  "engines": { "node": ">=22" },
```

In `scripts`, add:

```json
    "build:cli": "tsc -p tsconfig.cli.json && node -e \"require('fs').chmodSync('dist-cli/index.js', 0o755)\"",
    "test:e2e": "playwright test",
```

- [ ] **Step 5: Write `cli/types.ts`**

```ts
/** Parsed command-line options. */
export interface CliOptions {
  /** File or directory path, or null when --plan was used. */
  target: string | null
  plan: boolean
  /** 0 means "let the OS pick an ephemeral port". */
  port: number
  open: boolean
}

/** One document in the workspace. `relPath` is always a bare filename. */
export interface WorkspaceFile {
  name: string
  relPath: string
}

export interface WorkspaceDescriptor {
  /** Absolute path to the directory that bounds all file access. */
  root: string
  files: WorkspaceFile[]
  /** relPath of the document to open first. */
  active: string
}

export interface WatchEvent {
  type: 'changed' | 'removed'
  relPath: string
}
```

- [ ] **Step 6: Write the failing test**

Create `cli/args.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseCliArgs, UsageError } from './args.js'

describe('parseCliArgs', () => {
  it('accepts a single file target', () => {
    expect(parseCliArgs(['notes.md'])).toEqual({
      target: 'notes.md',
      plan: false,
      port: 0,
      open: true,
    })
  })

  it('accepts --plan with no positional', () => {
    expect(parseCliArgs(['--plan'])).toEqual({
      target: null,
      plan: true,
      port: 0,
      open: true,
    })
  })

  it('rejects --plan combined with a positional target', () => {
    expect(() => parseCliArgs(['--plan', 'notes.md'])).toThrow(UsageError)
  })

  it('rejects no target at all', () => {
    expect(() => parseCliArgs([])).toThrow(UsageError)
  })

  it('rejects more than one positional', () => {
    expect(() => parseCliArgs(['a.md', 'b.md'])).toThrow(UsageError)
  })

  it('parses --port', () => {
    expect(parseCliArgs(['--port', '8080', 'a.md']).port).toBe(8080)
  })

  it('rejects a non-numeric port', () => {
    expect(() => parseCliArgs(['--port', 'abc', 'a.md'])).toThrow(UsageError)
  })

  it('rejects an out-of-range port', () => {
    expect(() => parseCliArgs(['--port', '99999', 'a.md'])).toThrow(UsageError)
  })

  it('honours --no-open', () => {
    expect(parseCliArgs(['--no-open', 'a.md']).open).toBe(false)
  })

  it('reports --help via UsageError carrying the usage text', () => {
    expect(() => parseCliArgs(['--help'])).toThrow(UsageError)
  })
})
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `Failed to resolve import "./args.js"`. This also confirms the `cli` Vitest project is picking the file up.

- [ ] **Step 8: Implement `cli/args.ts`**

```ts
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
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — 32 tests (22 existing + 10 new).

- [ ] **Step 10: Verify the CLI build target emits, loads, and lints**

Run: `pnpm build:cli && pnpm typecheck && pnpm lint`
Expected: all exit 0, and `dist-cli/args.js` exists.

> `composite: true` requires declaration emit — do NOT add `"declaration": false`,
> which fails with `TS6304: Composite projects may not disable declaration emit`.
> The `.d.ts` files land in the git-ignored `dist-cli/`, which is harmless.

Then confirm the emitted ESM actually loads under Node:

```bash
node --input-type=module -e "
  const m = await import('./dist-cli/args.js')
  console.log(typeof m.parseCliArgs, m.parseCliArgs(['a.md']).target)
"
```

Expected: `function a.md`.

> **Scope note.** This step proves three things: Vitest resolves `.js` specifiers to
> `.ts` sources for the `cli` project, `tsc` emits Node ESM successfully, and the
> emitted module loads. It does **not** prove that a relative `.js` specifier survives
> emit, because every relative import in Task 1's sources is `import type`, which
> TypeScript always erases. The first value-level relative import in `cli/` appears in
> Task 3 (`workspace.ts` imports `DOC_EXTENSIONS` from `./resolve.js`), and Task 3's
> Step 4 carries the check that closes this gap. Do not add an otherwise-unused value
> import here just to satisfy a grep.

- [ ] **Step 11: Add `dist-cli` to `.gitignore` and commit**

Append to the "Build output" section of `.gitignore`:

```
dist-cli/
*.tsbuildinfo
```

`*.tsbuildinfo` is already covered — verify before adding a duplicate.

```bash
git add cli tsconfig.cli.json tsconfig.json tsconfig.node.json vitest.workspace.ts package.json pnpm-lock.yaml eslint.config.js .gitignore
git rm vitest.config.ts
git commit -m "feat(cli): add CLI build target and argument parsing"
```

---

### Task 2: Workspace resolution

**Files:**

- Create: `cli/resolve.ts`, `cli/resolve.test.ts`

**Interfaces:**

- Consumes: `CliOptions`, `WorkspaceDescriptor`, `WorkspaceFile` from `./types.js`.
- Produces: `resolveWorkspace(opts: CliOptions, plansDir?: string): Promise<WorkspaceDescriptor>`, `ResolveError`, `DOC_EXTENSIONS`, `PLANS_DIR`.

- [ ] **Step 1: Write the failing test**

Create `cli/resolve.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ResolveError, resolveWorkspace } from './resolve.js'
import type { CliOptions } from './types.js'

const dirs: string[] = []

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-resolve-'))
  dirs.push(dir)
  return dir
}

function opts(over: Partial<CliOptions>): CliOptions {
  return { target: null, plan: false, port: 0, open: false, ...over }
}

/** Write a file with an explicit mtime so "newest" ordering is deterministic. */
async function writeAt(dir: string, name: string, body: string, epochMs: number): Promise<void> {
  const full = path.join(dir, name)
  await fs.writeFile(full, body, 'utf8')
  const when = new Date(epochMs)
  await fs.utimes(full, when, when)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('resolveWorkspace', () => {
  it('resolves a single file to its parent directory', async () => {
    const dir = await tmpDir()
    await writeAt(dir, 'notes.md', '# hi', 1_000_000)

    const ws = await resolveWorkspace(opts({ target: path.join(dir, 'notes.md') }))

    expect(ws.root).toBe(await fs.realpath(dir))
    expect(ws.files).toEqual([{ name: 'notes.md', relPath: 'notes.md' }])
    expect(ws.active).toBe('notes.md')
  })

  it('lists a directory alphabetically and activates the first entry', async () => {
    const dir = await tmpDir()
    await writeAt(dir, 'zeta.md', 'z', 3_000_000)
    await writeAt(dir, 'alpha.markdown', 'a', 1_000_000)
    await writeAt(dir, 'notes.txt', 'n', 2_000_000)
    await writeAt(dir, 'ignored.png', 'x', 2_000_000)

    const ws = await resolveWorkspace(opts({ target: dir }))

    expect(ws.files.map((f) => f.relPath)).toEqual(['alpha.markdown', 'notes.txt', 'zeta.md'])
    expect(ws.active).toBe('alpha.markdown')
  })

  it('activates the newest file for --plan but lists them all', async () => {
    const plans = await tmpDir()
    await writeAt(plans, 'older.md', 'o', 1_000_000)
    await writeAt(plans, 'newest.md', 'n', 9_000_000)
    await writeAt(plans, 'middle.md', 'm', 5_000_000)

    const ws = await resolveWorkspace(opts({ plan: true }), plans)

    expect(ws.active).toBe('newest.md')
    expect(ws.files.map((f) => f.relPath).sort()).toEqual(['middle.md', 'newest.md', 'older.md'])
  })

  // Every negative path asserts the error TYPE as well as the message. The type is
  // the contract Task 6's entry point relies on (`err instanceof ResolveError` picks
  // a clean one-line CLI error over a stack trace), so a regression that threw a bare
  // Error with matching text must not pass.
  it('errors when the target does not exist', async () => {
    const dir = await tmpDir()
    const call = resolveWorkspace(opts({ target: path.join(dir, 'nope.md') }))
    await expect(call).rejects.toThrow(ResolveError)
    await expect(call).rejects.toThrow(/no such file or directory/)
  })

  it('errors when a directory holds no documents', async () => {
    const dir = await tmpDir()
    await expect(resolveWorkspace(opts({ target: dir }))).rejects.toThrow(ResolveError)
  })

  it('errors when the target is a file with an unsupported extension', async () => {
    const dir = await tmpDir()
    await writeAt(dir, 'image.png', 'not markdown', 1_000_000)
    const call = resolveWorkspace(opts({ target: path.join(dir, 'image.png') }))
    await expect(call).rejects.toThrow(ResolveError)
    await expect(call).rejects.toThrow(/not a markdown file/)
  })

  it('errors with an install hint when the plans directory is missing', async () => {
    const dir = await tmpDir()
    const missing = path.join(dir, 'no-plans-here')
    const call = resolveWorkspace(opts({ plan: true }), missing)
    await expect(call).rejects.toThrow(ResolveError)
    await expect(call).rejects.toThrow(/Is Claude Code installed\?/)
  })

  it('errors when the plans directory exists but is empty', async () => {
    const plans = await tmpDir()
    const call = resolveWorkspace(opts({ plan: true }), plans)
    await expect(call).rejects.toThrow(ResolveError)
    await expect(call).rejects.toThrow(/Is Claude Code installed\?/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- cli/resolve.test.ts`
Expected: FAIL — cannot resolve `./resolve.js`.

- [ ] **Step 3: Implement `cli/resolve.ts`**

```ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CliOptions, WorkspaceDescriptor, WorkspaceFile } from './types.js'

/** Extensions treated as editable documents. Lowercase, dot-prefixed. */
export const DOC_EXTENSIONS = ['.md', '.markdown', '.txt'] as const

export const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans')

/** Thrown when the requested target cannot become a usable workspace. */
export class ResolveError extends Error {}

function isDoc(name: string): boolean {
  const ext = path.extname(name).toLowerCase()
  return (DOC_EXTENSIONS as readonly string[]).includes(ext)
}

async function listDocs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && isDoc(e.name))
    .map((e) => e.name)
}

function toFiles(names: string[]): WorkspaceFile[] {
  return names.map((name) => ({ name, relPath: name }))
}

async function newestByMtime(dir: string, names: string[]): Promise<string> {
  const stats = await Promise.all(
    names.map(async (name) => ({ name, mtimeMs: (await fs.stat(path.join(dir, name))).mtimeMs }))
  )
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
  return stats[0].name
}

async function resolvePlans(plansDir: string): Promise<WorkspaceDescriptor> {
  const hint = `No plans directory found at ${plansDir}. Is Claude Code installed? Pass a file or directory instead.`
  let names: string[]
  try {
    names = await listDocs(plansDir)
  } catch {
    throw new ResolveError(hint)
  }
  if (names.length === 0) throw new ResolveError(hint)

  const root = await fs.realpath(plansDir)
  return { root, files: toFiles(names.sort()), active: await newestByMtime(root, names) }
}

async function resolveTarget(target: string): Promise<WorkspaceDescriptor> {
  const abs = path.resolve(target)
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(abs)
  } catch {
    throw new ResolveError(`no such file or directory: ${target}`)
  }

  if (stat.isDirectory()) {
    const names = await listDocs(abs)
    if (names.length === 0) {
      throw new ResolveError(`no ${DOC_EXTENSIONS.join(', ')} files found in ${target}`)
    }
    const sorted = names.sort()
    return { root: await fs.realpath(abs), files: toFiles(sorted), active: sorted[0] }
  }

  if (!isDoc(abs)) {
    throw new ResolveError(
      `${target} is not a markdown file (expected one of ${DOC_EXTENSIONS.join(', ')})`
    )
  }
  const name = path.basename(abs)
  return {
    root: await fs.realpath(path.dirname(abs)),
    files: toFiles([name]),
    active: name,
  }
}

export async function resolveWorkspace(
  opts: CliOptions,
  plansDir: string = PLANS_DIR
): Promise<WorkspaceDescriptor> {
  if (opts.plan) return resolvePlans(plansDir)
  if (opts.target === null) throw new ResolveError('no target to resolve')
  return resolveTarget(opts.target)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- cli/resolve.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/resolve.ts cli/resolve.test.ts
git commit -m "feat(cli): resolve files, directories, and --plan into a workspace"
```

---

### Task 3: Workspace file access and path confinement

The security core. Every rejection here is a vulnerability that does not happen.

**Files:**

- Create: `cli/workspace.ts`, `cli/workspace.test.ts`

**Interfaces:**

- Consumes: `WorkspaceDescriptor`, `WorkspaceFile` from `./types.js`; `DOC_EXTENSIONS` from `./resolve.js`.
- Produces: `class Workspace` with `root: string`, `active: string`, `list(): WorkspaceFile[]`, `read(relPath): Promise<DocRead>`, `write(relPath, content, baseMtimeMs): Promise<{ mtimeMs: number }>`; plus `PathError`, `ConflictError` (with `mtimeMs: number | null`), `NotFoundError`, `DocRead`.

- [ ] **Step 1: Write the failing test**

Create `cli/workspace.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ConflictError, NotFoundError, PathError, Workspace } from './workspace.js'

const dirs: string[] = []

async function fixture(): Promise<{ root: string; outside: string; ws: Workspace }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-ws-'))
  dirs.push(base)
  const root = path.join(base, 'root')
  const outside = path.join(base, 'outside')
  await fs.mkdir(root)
  await fs.mkdir(outside)
  await fs.mkdir(path.join(root, 'sub'))
  await fs.writeFile(path.join(root, 'notes.md'), '# notes', 'utf8')
  await fs.writeFile(path.join(root, 'sub', 'nested.md'), 'nested', 'utf8')
  await fs.writeFile(path.join(outside, 'secret.md'), 'SECRET', 'utf8')
  const ws = new Workspace({
    root: await fs.realpath(root),
    files: [{ name: 'notes.md', relPath: 'notes.md' }],
    active: 'notes.md',
  })
  return { root, outside, ws }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('Workspace path confinement', () => {
  const rejected: Array<[string, string]> = [
    ['parent traversal', '../outside/secret.md'],
    ['deep traversal', 'a/../../outside/secret.md'],
    ['absolute path', '/etc/passwd'],
    ['subdirectory', 'sub/nested.md'],
    ['null byte', 'notes\u0000.md'],
    ['empty string', ''],
    ['bare dot', '.'],
    ['percent-encoded traversal', '%2e%2e/secret.md'],
    ['disallowed extension', 'notes.exe'],
  ]

  for (const [label, relPath] of rejected) {
    it(`rejects ${label}`, async () => {
      const { ws } = await fixture()
      await expect(ws.read(relPath)).rejects.toThrow(PathError)
      await expect(ws.write(relPath, 'pwned', null)).rejects.toThrow(PathError)
    })
  }

  it('reads a confined file', async () => {
    const { ws } = await fixture()
    const doc = await ws.read('notes.md')
    expect(doc.content).toBe('# notes')
    expect(doc.relPath).toBe('notes.md')
    expect(doc.mtimeMs).toBeGreaterThan(0)
  })

  it('reports a missing document as NotFoundError, not a raw errno', async () => {
    const { ws } = await fixture()
    await expect(ws.read('ghost.md')).rejects.toThrow(NotFoundError)
  })
})

// A dangling symlink is the case that made the earlier implementation escape the
// root: realpath reports ENOENT for "nothing here" AND for "symlink with a missing
// target", so treating ENOENT as "safe to create" let writeFile follow the link and
// write outside the workspace. These two tests are the regression guard.
describe('Workspace symlink escapes', () => {
  it('refuses to read or write through a symlink pointing outside the root', async () => {
    const { root, outside, ws } = await fixture()
    await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'escape.md'))

    await expect(ws.read('escape.md')).rejects.toThrow(PathError)
    await expect(ws.write('escape.md', 'pwned', null)).rejects.toThrow(PathError)

    expect(await fs.readFile(path.join(outside, 'secret.md'), 'utf8')).toBe('SECRET')
  })

  it('refuses to write through a DANGLING symlink and creates nothing outside', async () => {
    const { root, outside, ws } = await fixture()
    const target = path.join(outside, 'implanted.md')
    await fs.symlink(target, path.join(root, 'escape.md'))

    await expect(ws.write('escape.md', 'PWNED', null)).rejects.toThrow(PathError)
    await expect(ws.write('escape.md', 'PWNED', 1_700_000_000_000)).rejects.toThrow(PathError)
    await expect(ws.read('escape.md')).rejects.toThrow(PathError)

    // The whole point: nothing may have appeared at the link's target.
    await expect(fs.access(target)).rejects.toThrow()
  })

  // A symlink that stays inside the root still must not launder the type and
  // extension checks a direct leaf gets. Pointing one at a directory produced a
  // raw EISDIR, at a FIFO made open() block forever, and at `payload.sh` wrote
  // outside the allowlist while staying in-root.
  it('refuses a symlink to an in-root directory', async () => {
    const { root, ws } = await fixture()
    await fs.symlink(path.join(root, 'sub'), path.join(root, 'dirlink.md'))

    await expect(ws.read('dirlink.md')).rejects.toThrow(PathError)
    await expect(ws.write('dirlink.md', 'x', null)).rejects.toThrow(PathError)
  })

  it('refuses a symlink to an in-root file outside the extension allowlist', async () => {
    const { root, ws } = await fixture()
    await fs.writeFile(path.join(root, 'payload.sh'), '#!/bin/sh\n', 'utf8')
    await fs.symlink(path.join(root, 'payload.sh'), path.join(root, 'alias.md'))

    await expect(ws.read('alias.md')).rejects.toThrow(PathError)
    await expect(ws.write('alias.md', 'rm -rf /', null)).rejects.toThrow(PathError)

    expect(await fs.readFile(path.join(root, 'payload.sh'), 'utf8')).toBe('#!/bin/sh\n')
  })

  it('accepts a symlink to an in-root document and follows it', async () => {
    const { root, ws } = await fixture()
    await fs.symlink(path.join(root, 'notes.md'), path.join(root, 'alias.md'))

    expect((await ws.read('alias.md')).content).toBe('# notes')

    const before = await ws.read('alias.md')
    await ws.write('alias.md', 'via alias', before.mtimeMs)
    expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe('via alias')
  })

  // Reachable from a plain request with no local staging: an over-long name must
  // be a bad request, not a raw ENAMETOOLONG surfacing as a 500.
  it('reports an over-long filename as PathError, not a raw errno', async () => {
    const { ws } = await fixture()
    const tooLong = `${'x'.repeat(300)}.md`

    await expect(ws.read(tooLong)).rejects.toThrow(PathError)
    await expect(ws.write(tooLong, 'x', null)).rejects.toThrow(PathError)
  })
})

describe('Workspace writes', () => {
  it('writes when the base mtime matches', async () => {
    const { root, ws } = await fixture()
    const before = await ws.read('notes.md')

    const result = await ws.write('notes.md', 'updated', before.mtimeMs)

    expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe('updated')
    expect(result.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs)
  })

  it('throws ConflictError when the file moved underneath', async () => {
    const { ws } = await fixture()
    const before = await ws.read('notes.md')

    await expect(ws.write('notes.md', 'mine', before.mtimeMs - 5000)).rejects.toThrow(ConflictError)
  })

  it('creates a new file when baseMtimeMs is null', async () => {
    const { root, ws } = await fixture()
    await ws.write('fresh.md', 'brand new', null)
    expect(await fs.readFile(path.join(root, 'fresh.md'), 'utf8')).toBe('brand new')
  })

  it('refuses to overwrite an existing file when baseMtimeMs is null', async () => {
    const { ws } = await fixture()
    await expect(ws.write('notes.md', 'clobber', null)).rejects.toThrow(ConflictError)
  })

  it('refuses a non-null base mtime when the file no longer exists', async () => {
    const { ws } = await fixture()
    await expect(ws.write('ghost.md', 'x', 1_700_000_000_000)).rejects.toThrow(ConflictError)
  })

  // Every conflict check is a positive comparison, and NaN makes all of them
  // false — so without an explicit guard a NaN base slips past all three and
  // overwrites the file. The HTTP layer builds this value from a JSON body.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses a %s base mtime instead of clobbering', async (_label, base) => {
    const { root, ws } = await fixture()

    await expect(ws.write('notes.md', 'CLOBBERED', base)).rejects.toThrow(PathError)

    expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe('# notes')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- cli/workspace.test.ts`
Expected: FAIL — cannot resolve `./workspace.js`.

- [ ] **Step 3: Implement `cli/workspace.ts`**

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { DOC_EXTENSIONS } from './resolve.js'
import type { WorkspaceDescriptor, WorkspaceFile } from './types.js'

/** Thrown when a requested path is not a plain document inside the root. */
export class PathError extends Error {}

/**
 * Thrown when the on-disk state no longer matches what the client loaded.
 * `mtimeMs` is null when there is no on-disk version to report.
 */
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly mtimeMs: number | null
  ) {
    super(message)
  }
}

/**
 * Thrown when a confined path names nothing readable. Distinct from PathError so
 * the HTTP layer can answer 404 instead of turning a routine missing file into a
 * 500 by letting a raw errno escape.
 */
export class NotFoundError extends Error {}

export interface DocRead {
  relPath: string
  content: string
  mtimeMs: number
}

/**
 * The single gateway to document contents. Every path crossing this boundary is
 * validated to be a bare filename with an allowed extension that resolves,
 * after symlinks, inside `root`.
 *
 * The invariant `server.ts` must uphold: it never derives a document path from a
 * request and hands it to `fs` itself — every read and write of user content goes
 * through this class. `server.ts` does use `fs` to serve the built app bundle, but
 * only against `distDir`, which is confined separately and never influenced by a
 * workspace-relative path. Reviewers should check that invariant rather than the
 * mere absence of an `fs` import.
 */
export class Workspace {
  constructor(private readonly descriptor: WorkspaceDescriptor) {}

  get root(): string {
    return this.descriptor.root
  }

  get active(): string {
    return this.descriptor.active
  }

  list(): WorkspaceFile[] {
    return this.descriptor.files.slice()
  }

  /** Syntactic validation: bare filename, allowed extension, inside root. */
  private confine(relPath: string): string {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw new PathError('path must be a non-empty string')
    }
    if (relPath.includes('\0')) {
      throw new PathError('path contains a null byte')
    }
    if (path.isAbsolute(relPath)) {
      throw new PathError('absolute paths are not allowed')
    }
    // A bare filename is the only accepted shape: no separators, no dot-segments.
    if (relPath !== path.basename(relPath)) {
      throw new PathError('only files directly inside the workspace are allowed')
    }
    if (relPath === '.' || relPath === '..') {
      throw new PathError('path must name a file')
    }
    const ext = path.extname(relPath).toLowerCase()
    if (!(DOC_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new PathError(`unsupported file type: ${ext || '(none)'}`)
    }

    const abs = path.resolve(this.root, relPath)
    if (Workspace.escapes(this.root, abs)) {
      throw new PathError('path escapes the workspace root')
    }
    return abs
  }

  /** True when `candidate` is outside `root` (or is the root itself). */
  private static escapes(root: string, candidate: string): boolean {
    const rel = path.relative(root, candidate)
    // Compare whole path segments: a bare startsWith('..') also matches the
    // legitimate filename '..md'.
    return rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)
  }

  /**
   * Syntactic validation plus symlink resolution against the real root.
   *
   * The leaf is inspected with `lstat`, never `realpath` alone. `realpath`
   * reports ENOENT both for "nothing here" and for "a symlink whose target is
   * missing", and conflating those let a dangling symlink inside the root pass
   * validation — after which `writeFile` followed the link and created a file
   * at an arbitrary absolute path outside the workspace. `lstat` distinguishes
   * the two cases, so a symlink is always resolved and range-checked, and an
   * unresolvable one is refused rather than written through.
   */
  private async confineReal(relPath: string): Promise<string> {
    const abs = this.confine(relPath)
    const realRoot = await fs.realpath(this.root)

    let leaf: Awaited<ReturnType<typeof fs.lstat>>
    try {
      leaf = await fs.lstat(abs)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // Genuinely absent — no link to follow. confine() already proved this
        // path sits directly under the root, so creating it here is safe.
        return abs
      }
      // Any other errno here is a property of the requested name (ENAMETOOLONG,
      // ENOTDIR, EACCES...). Those are bad-request conditions, not server faults,
      // and an over-long filename is reachable from a plain HTTP request.
      throw new PathError(`cannot inspect path: ${code ?? 'unknown error'}`)
    }

    if (leaf.isSymbolicLink()) {
      let real: string
      try {
        real = await fs.realpath(abs)
      } catch {
        throw new PathError('path is a symlink whose target cannot be resolved')
      }
      if (Workspace.escapes(realRoot, real)) {
        throw new PathError('resolved path escapes the workspace root')
      }
      // The resolved target gets the same scrutiny as a direct leaf. Without this
      // an in-root symlink launders every check that follows: pointing it at a
      // directory yields a raw EISDIR, at a FIFO makes open() block forever and
      // burn a libuv threadpool thread, and at `payload.sh` defeats the
      // extension allowlist while staying inside the root.
      const targetExt = path.extname(real).toLowerCase()
      if (!(DOC_EXTENSIONS as readonly string[]).includes(targetExt)) {
        throw new PathError('symlink target is not a supported file type')
      }
      if (!(await fs.stat(real)).isFile()) {
        throw new PathError('symlink target is not a regular file')
      }
      // Return the resolved path so later syscalls do not re-traverse the link.
      return real
    }

    if (!leaf.isFile()) {
      throw new PathError('path is not a regular file')
    }

    return abs
  }

  async read(relPath: string): Promise<DocRead> {
    const abs = await this.confineReal(relPath)
    // Read content and mtime through one descriptor so they describe the same
    // version of the file. Two independent path-based syscalls can straddle an
    // external write, pairing stale content with a fresh mtime — after which the
    // client's next save passes the base-mtime check and silently discards that
    // write. This is not fully atomic (readFile is several reads and stat is a
    // separate fstat), but it does pin the inode, so a rename-replace writer can
    // no longer produce a mismatched pair.
    let handle: Awaited<ReturnType<typeof fs.open>>
    try {
      handle = await fs.open(abs, 'r')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // ENOENT is the only expected failure: confineReal has already proved the
      // leaf is a regular file, so EISDIR cannot reach here. Anything else is a
      // property of the request (EACCES on a mode-000 file), not a server fault.
      if (code === 'ENOENT') throw new NotFoundError(`no such document: ${relPath}`)
      throw new PathError(`cannot open document: ${code ?? 'unknown error'}`)
    }
    try {
      const [content, stat] = await Promise.all([handle.readFile('utf8'), handle.stat()])
      return { relPath, content, mtimeMs: stat.mtimeMs }
    } finally {
      await handle.close()
    }
  }

  /**
   * Write `content`, refusing when disk has moved since the client loaded it.
   * `baseMtimeMs === null` means "this should be a new file".
   */
  async write(
    relPath: string,
    content: string,
    baseMtimeMs: number | null
  ): Promise<{ mtimeMs: number }> {
    // Guard the base mtime before any comparison. Every check below is a
    // positive comparison, and NaN makes all of them false — so a NaN or
    // non-numeric base would fall straight through to writeFile and silently
    // clobber the file this mechanism exists to protect. The HTTP layer coerces
    // this value out of a JSON body, so a bad value is reachable, not theoretical.
    if (baseMtimeMs !== null && !Number.isFinite(baseMtimeMs)) {
      throw new PathError('baseMtimeMs must be null or a finite number')
    }

    const abs = await this.confineReal(relPath)

    let current: number | null = null
    try {
      current = (await fs.stat(abs)).mtimeMs
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    if (baseMtimeMs === null && current !== null) {
      throw new ConflictError('file already exists on disk', current)
    }
    if (baseMtimeMs !== null && current === null) {
      throw new ConflictError('file no longer exists on disk', null)
    }
    if (baseMtimeMs !== null && current !== null && Math.abs(current - baseMtimeMs) > 1) {
      throw new ConflictError('file changed on disk since it was loaded', current)
    }

    await fs.writeFile(abs, content, 'utf8')
    return { mtimeMs: (await fs.stat(abs)).mtimeMs }
  }
}
```

> The 1ms tolerance in the mtime comparison absorbs filesystem timestamp
> granularity differences; anything larger is a genuine external write.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- cli/workspace.test.ts`
Expected: PASS — 24 tests (9 parameterised rejections + read + NotFoundError + 6 symlink cases

- over-long filename + 5 write cases + 2 parameterised non-finite-base cases). Count the `it.each` rows
  individually; if your run reports fewer, find out which case did not register rather than
  adjusting this number.

Then close the emit-survival gap Task 1 deferred. `workspace.ts` contains the first
**value-level** relative import in `cli/` (`import { DOC_EXTENSIONS } from './resolve.js'`),
so this is the first point at which a `.js` specifier must survive `tsc` emit:

```bash
pnpm build:cli && grep -n "from '\./resolve\.js'" dist-cli/workspace.js
node --input-type=module -e "
  const m = await import('./dist-cli/workspace.js')
  console.log(typeof m.Workspace, typeof m.PathError)
"
```

Expected: the grep prints a matching line (double or single quotes both fine — adjust the
pattern if `tsc` emits double quotes), and the node command prints `function function`.
A resolution failure here means the `.js`-extension convention is broken for emitted
output and must be fixed before Task 5 depends on it.

- [ ] **Step 5: Commit**

```bash
git add cli/workspace.ts cli/workspace.test.ts
git commit -m "feat(cli): add workspace file access with path confinement"
```

---

### Task 4: Debounced file watcher

**Files:**

- Create: `cli/watch.ts`, `cli/watch.test.ts`

**Interfaces:**

- Consumes: `WatchEvent` from `./types.js`; `DOC_EXTENSIONS` from `./resolve.js`.
- Produces: `watchWorkspace(root, onEvent, opts?): () => void`, `WatcherFactory`, `nodeWatcherFactory`.

The watcher factory is injectable so tests never depend on real `fs.watch` timing — the suite stays deterministic rather than flaky.

- [ ] **Step 1: Write the failing test**

Create `cli/watch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchWorkspace, type WatcherFactory } from './watch.js'
import type { WatchEvent } from './types.js'

type Emit = (event: string, filename: string | null) => void

function stubFactory(): { factory: WatcherFactory; emit: Emit; closed: () => boolean } {
  let emit: Emit = () => {}
  let closed = false
  const factory: WatcherFactory = (_root, cb) => {
    emit = cb
    return {
      close: () => {
        closed = true
      },
    }
  }
  return { factory, emit: (e, f) => emit(e, f), closed: () => closed }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('watchWorkspace', () => {
  it('emits a changed event after the debounce window', () => {
    const events: WatchEvent[] = []
    const { factory, emit } = stubFactory()
    watchWorkspace('/root', (e) => events.push(e), { debounceMs: 50, factory, exists: () => true })

    emit('change', 'notes.md')
    expect(events).toEqual([])

    vi.advanceTimersByTime(50)
    expect(events).toEqual([{ type: 'changed', relPath: 'notes.md' }])
  })

  it('collapses a burst of writes into one event', () => {
    const events: WatchEvent[] = []
    const { factory, emit } = stubFactory()
    watchWorkspace('/root', (e) => events.push(e), { debounceMs: 50, factory, exists: () => true })

    emit('change', 'notes.md')
    vi.advanceTimersByTime(20)
    emit('change', 'notes.md')
    vi.advanceTimersByTime(20)
    emit('change', 'notes.md')
    vi.advanceTimersByTime(50)

    expect(events).toEqual([{ type: 'changed', relPath: 'notes.md' }])
  })

  it('debounces each file independently', () => {
    const events: WatchEvent[] = []
    const { factory, emit } = stubFactory()
    watchWorkspace('/root', (e) => events.push(e), { debounceMs: 50, factory, exists: () => true })

    emit('change', 'a.md')
    emit('change', 'b.md')
    vi.advanceTimersByTime(50)

    expect(events.map((e) => e.relPath).sort()).toEqual(['a.md', 'b.md'])
  })

  it('ignores files with unsupported extensions', () => {
    const events: WatchEvent[] = []
    const { factory, emit } = stubFactory()
    watchWorkspace('/root', (e) => events.push(e), { debounceMs: 50, factory, exists: () => true })

    emit('change', 'image.png')
    emit('change', 'notes.md.swp')
    vi.advanceTimersByTime(50)

    expect(events).toEqual([])
  })

  it('ignores paths that are not bare filenames', () => {
    const events: WatchEvent[] = []
    const { factory, emit } = stubFactory()
    watchWorkspace('/root', (e) => events.push(e), { debounceMs: 50, factory, exists: () => true })

    emit('change', 'sub/nested.md')
    emit('change', null)
    vi.advanceTimersByTime(50)

    expect(events).toEqual([])
  })

  it('reports a vanished file as removed', () => {
    const events: WatchEvent[] = []
    const { factory, emit } = stubFactory()
    watchWorkspace('/root', (e) => events.push(e), {
      debounceMs: 50,
      factory,
      exists: () => false,
    })

    emit('rename', 'gone.md')
    vi.advanceTimersByTime(50)

    expect(events).toEqual([{ type: 'removed', relPath: 'gone.md' }])
  })

  it('closes the underlying watcher and stops emitting', () => {
    const events: WatchEvent[] = []
    const { factory, emit, closed } = stubFactory()
    const stop = watchWorkspace('/root', (e) => events.push(e), {
      debounceMs: 50,
      factory,
      exists: () => true,
    })

    emit('change', 'notes.md')

    // Assert the timer is actually cancelled, not merely muted. Dropping
    // clearTimeout from stop() would leave this pending timeout to fire, hit the
    // `stopped` guard and emit nothing — so the events assertion below would
    // still pass while a real timer kept the Node event loop alive after
    // Ctrl-C. Only the timer count can distinguish those two states.
    expect(vi.getTimerCount()).toBe(1)
    stop()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(50)

    expect(closed()).toBe(true)
    expect(events).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- cli/watch.test.ts`
Expected: FAIL — cannot resolve `./watch.js`.

- [ ] **Step 3: Implement `cli/watch.ts`**

```ts
import fs from 'node:fs'
import path from 'node:path'
import { DOC_EXTENSIONS } from './resolve.js'
import type { WatchEvent } from './types.js'

export interface RawWatcher {
  close(): void
}

export type WatcherFactory = (
  root: string,
  cb: (event: string, filename: string | null) => void
) => RawWatcher

export const nodeWatcherFactory: WatcherFactory = (root, cb) => {
  const watcher = fs.watch(root, { persistent: true }, cb)
  // FSWatcher is an EventEmitter, so an unhandled 'error' would throw and take
  // the whole CLI down. Losing live updates is recoverable; losing the server
  // mid-edit is not. Report and carry on serving.
  watcher.on('error', (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`better-md: stopped watching ${root}: ${message}\n`)
  })
  return watcher
}

export interface WatchOptions {
  debounceMs?: number
  factory?: WatcherFactory
  /** Existence probe, injectable so tests stay hermetic. */
  exists?: (absPath: string) => boolean
}

/**
 * Watch `root` for document changes, collapsing bursts per file. Editors and
 * agents commonly write a file several times in quick succession; without
 * debouncing the client would reload mid-write and see truncated content.
 */
export function watchWorkspace(
  root: string,
  onEvent: (event: WatchEvent) => void,
  options: WatchOptions = {}
): () => void {
  const debounceMs = options.debounceMs ?? 50
  const factory = options.factory ?? nodeWatcherFactory
  const exists = options.exists ?? ((abs: string) => fs.existsSync(abs))
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let stopped = false

  const watcher = factory(root, (_event, filename) => {
    if (stopped || filename === null) return
    // fs.watch can report nested or non-document paths; only bare docs matter.
    if (filename !== path.basename(filename)) return
    const ext = path.extname(filename).toLowerCase()
    if (!(DOC_EXTENSIONS as readonly string[]).includes(ext)) return

    const existing = timers.get(filename)
    if (existing !== undefined) clearTimeout(existing)
    timers.set(
      filename,
      setTimeout(() => {
        timers.delete(filename)
        if (stopped) return
        const present = exists(path.join(root, filename))
        onEvent({ type: present ? 'changed' : 'removed', relPath: filename })
      }, debounceMs)
    )
  })

  return () => {
    stopped = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    watcher.close()
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- cli/watch.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/watch.ts cli/watch.test.ts
git commit -m "feat(cli): add debounced workspace file watcher"
```

---

### Task 5: HTTP server, JSON API, and SSE

**Files:**

- Create: `cli/server.ts`, `cli/server.test.ts`

**Interfaces:**

- Consumes: `Workspace`, `PathError`, `ConflictError` from `./workspace.js`; `WatchEvent` from `./types.js`.
- Produces: `startServer(options: ServerOptions): Promise<ServerHandle>` where `ServerHandle = { url, origin, port, token, notify(event: WatchEvent): void, close(): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

Create `cli/server.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { startServer, type ServerHandle } from './server.js'
import { Workspace } from './workspace.js'

const cleanups: Array<() => Promise<void>> = []

interface Harness {
  handle: ServerHandle
  root: string
  dist: string
  /** A file outside dist, used to prove a symlink cannot reach it. */
  outsideSecret: string
  /** Everything the server logged during this test. */
  logs: string[]
}

async function harness(): Promise<Harness> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-server-'))
  const root = path.join(base, 'root')
  const dist = path.join(base, 'dist')
  const outsideSecret = path.join(base, 'SECRET.txt')
  await fs.mkdir(root)
  await fs.mkdir(path.join(dist, 'assets'), { recursive: true })
  await fs.writeFile(path.join(root, 'notes.md'), '# notes', 'utf8')
  await fs.writeFile(path.join(dist, 'index.html'), '<div id="root"></div>', 'utf8')
  await fs.writeFile(path.join(dist, 'assets', 'app.js'), 'console.log(1)', 'utf8')
  await fs.writeFile(outsideSecret, 'TOP-SECRET', 'utf8')

  const workspace = new Workspace({
    root: await fs.realpath(root),
    files: [{ name: 'notes.md', relPath: 'notes.md' }],
    active: 'notes.md',
  })
  // Capture the log instead of writing to stderr: it keeps the suite's output
  // pristine AND makes "what did the operator see" assertable.
  const logs: string[] = []
  const handle = await startServer({
    workspace,
    distDir: dist,
    log: (message) => logs.push(message),
  })
  cleanups.push(async () => {
    await handle.close()
    await fs.rm(base, { recursive: true, force: true })
  })
  return { handle, root, dist, outsideSecret, logs }
}

function auth(handle: ServerHandle): Record<string, string> {
  return { authorization: `Bearer ${handle.token}` }
}

/**
 * `Response.json()` is `Promise<unknown>` under @types/node (no DOM lib), so a
 * cast is required for property access under `strict`. Narrow, local shapes keep
 * that honest rather than reaching for `any`.
 */
interface DocBody {
  relPath: string
  content: string
  mtimeMs: number
}
interface ConflictBody {
  error: string
  theirContent: string | null
  theirMtimeMs: number | null
}
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

describe('static serving', () => {
  it('serves index.html at the root', async () => {
    const { handle } = await harness()
    const res = await fetch(handle.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('id="root"')
  })

  it('serves assets', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/assets/app.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
  })

  // The obvious payload does NOT work: the WHATWG URL parser matches %2e%2e as a
  // double-dot path segment and collapses it before any application code runs, so
  // `/assets/%2e%2e/%2e%2e/root/notes.md` arrives as `/root/notes.md` and 404s
  // without ever reaching the guard. Percent-encoded SEPARATORS survive the parser
  // intact, and decodeURIComponent then turns them into a real `../../`.
  it('refuses traversal out of the dist directory', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/assets/..%2f..%2froot/notes.md`)
    expect(res.status).toBe(400)
  })

  it('refuses a malformed percent-escape without logging', async () => {
    const { handle, logs } = await harness()
    const res = await fetch(`${handle.origin}/%zz`)
    expect(res.status).toBe(400)
    // This route has no auth gate, so a page could otherwise flood the terminal.
    expect(logs).toEqual([])
  })

  it('refuses a symlink inside dist that points outside it', async () => {
    const { handle, dist, outsideSecret } = await harness()
    await fs.symlink(outsideSecret, path.join(dist, 'assets', 'leak.js'))

    const res = await fetch(`${handle.origin}/assets/leak.js`)

    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('TOP-SECRET')
  })
})

describe('API authentication', () => {
  it('rejects a missing token with 401', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/workspace`)
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token with 401', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/workspace`, {
      headers: { authorization: 'Bearer not-the-token' },
    })
    expect(res.status).toBe(401)
  })

  // 'not-the-token' differs in LENGTH, so it short-circuits at the length check
  // and never reaches crypto.timingSafeEqual — the comparison this gate depends on
  // had no automated coverage at all. A same-length wrong token is the only input
  // that exercises it.
  it('rejects a same-length wrong token with 401', async () => {
    const { handle } = await harness()
    const wrong = handle.token.split('').reverse().join('')
    expect(wrong).toHaveLength(handle.token.length)
    expect(wrong).not.toBe(handle.token)

    const res = await fetch(`${handle.origin}/api/workspace`, {
      headers: { authorization: `Bearer ${wrong}` },
    })

    expect(res.status).toBe(401)
  })

  it('rejects a foreign Origin with 403', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/workspace`, {
      headers: { ...auth(handle), origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('accepts its own Origin', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/workspace`, {
      headers: { ...auth(handle), origin: handle.origin },
    })
    expect(res.status).toBe(200)
  })
})

describe('document API', () => {
  it('lists the workspace', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/workspace`, { headers: auth(handle) })
    expect(await res.json()).toEqual({
      files: [{ name: 'notes.md', relPath: 'notes.md' }],
      active: 'notes.md',
    })
  })

  it('reads a document', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/doc?path=notes.md`, { headers: auth(handle) })
    const body = await json<DocBody>(res)
    expect(body.content).toBe('# notes')
    expect(body.mtimeMs).toBeGreaterThan(0)
  })

  it('rejects a traversal path with 400', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/doc?path=${encodeURIComponent('../secret.md')}`, {
      headers: auth(handle),
    })
    expect(res.status).toBe(400)
  })

  it('saves a document and reports the new mtime', async () => {
    const { handle, root } = await harness()
    const read = await json<DocBody>(
      await fetch(`${handle.origin}/api/doc?path=notes.md`, { headers: auth(handle) })
    )

    const res = await fetch(`${handle.origin}/api/doc`, {
      method: 'PUT',
      headers: { ...auth(handle), 'content-type': 'application/json' },
      body: JSON.stringify({ relPath: 'notes.md', content: 'saved!', baseMtimeMs: read.mtimeMs }),
    })

    expect(res.status).toBe(200)
    expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe('saved!')
  })

  it('returns 409 with their content when the base mtime is stale', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/doc`, {
      method: 'PUT',
      headers: { ...auth(handle), 'content-type': 'application/json' },
      body: JSON.stringify({ relPath: 'notes.md', content: 'mine', baseMtimeMs: 1 }),
    })

    expect(res.status).toBe(409)
    const body = await json<ConflictBody>(res)
    expect(body.theirContent).toBe('# notes')
    expect(body.theirMtimeMs).toBeGreaterThan(0)
  })

  it('returns 404 for a document that does not exist', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/doc?path=ghost.md`, { headers: auth(handle) })
    expect(res.status).toBe(404)
  })

  // A non-numeric baseMtimeMs must not be coerced. Number('nonsense') is NaN, and
  // NaN compares false against every conflict check, so coercion here would let a
  // request overwrite a document without knowing its mtime.
  it.each([
    ['a string', 'nonsense'],
    ['a boolean', true],
    ['an object', {}],
  ])('rejects %s baseMtimeMs with 400 and leaves the file alone', async (_label, value) => {
    const { handle, root } = await harness()
    const res = await fetch(`${handle.origin}/api/doc`, {
      method: 'PUT',
      headers: { ...auth(handle), 'content-type': 'application/json' },
      body: JSON.stringify({ relPath: 'notes.md', content: 'CLOBBERED', baseMtimeMs: value }),
    })

    expect(res.status).toBe(400)
    expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe('# notes')
  })
})

describe('shutdown', () => {
  // Regression guard: server.close() alone waits on lingering connections, so a
  // half-sent request or an aborted SSE stream left it pending for seconds. The
  // CLI wires SIGINT to close(), so that reads to a user as Ctrl-C hanging.
  it('closes promptly with a half-sent request in flight', async () => {
    const { handle } = await harness()

    // Headers sent, body promised but never delivered — the connection lingers.
    const socket = net.connect(handle.port, '127.0.0.1')
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()))
    socket.write('PUT /api/doc HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 999\r\n\r\n{')

    const started = performance.now()
    await handle.close()
    const elapsed = performance.now() - started

    // Generous bound: the failure mode was seconds, not milliseconds.
    expect(elapsed).toBeLessThan(1000)
    socket.destroy()
  })
})

describe('malformed request targets', () => {
  /**
   * `fetch` cannot send an unparseable target — its own URL parser rejects it
   * first — so this needs a raw socket. Worth the awkwardness: before the guard,
   * `new URL(req.url)` threw synchronously inside the http listener, which
   * `done.catch` never sees, so the CLI died with an uncaughtException. Nothing
   * in the fetch-based suite could reach that.
   */
  function rawRequest(port: number, target: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
      })
      let data = ''
      socket.setTimeout(5000, () => {
        socket.destroy()
        reject(new Error(`no response for ${target}`))
      })
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8')
      })
      socket.on('end', () => resolve(data))
      socket.on('error', reject)
    })
  }

  it.each([
    ['bracketed host', '//[::1'],
    ['bare scheme', 'https://['],
  ])('answers 400 for a %s target and keeps serving', async (_label, target) => {
    const { handle } = await harness()

    expect(await rawRequest(handle.port, target)).toContain('400')

    // The real regression: the process must still be alive and serving.
    const after = await fetch(`${handle.origin}/`)
    expect(after.status).toBe(200)
  })
})

describe('error handling', () => {
  // Workspace.write lets fs.writeFile errors through raw, and a raw errno message
  // embeds the absolute path. The 500 body must never carry it.
  it('does not leak filesystem paths in a 500', async () => {
    const { handle, root } = await harness()
    const target = path.join(root, 'notes.md')
    const mtimeMs = (await fs.stat(target)).mtimeMs
    await fs.chmod(target, 0o444)
    // Registered, not trailing: a failed assertion below must not skip the restore.
    cleanups.push(() => fs.chmod(target, 0o644))

    const res = await fetch(`${handle.origin}/api/doc`, {
      method: 'PUT',
      headers: { ...auth(handle), 'content-type': 'application/json' },
      body: JSON.stringify({ relPath: 'notes.md', content: 'nope', baseMtimeMs: mtimeMs }),
    })

    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain(root)
    expect(text).not.toContain(os.tmpdir())

    // The operator DOES get the detail — that asymmetry is the point, and it is
    // the only assertion that proves the detail was not simply discarded.
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('EACCES')
    expect(logs[0]).toContain(target)
  })
})

describe('events', () => {
  it('streams a notified change over SSE', async () => {
    const { handle } = await harness()
    const res = await fetch(`${handle.origin}/api/events`, { headers: auth(handle) })
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    handle.notify({ type: 'changed', relPath: 'notes.md' })

    // The preamble and the event are separate chunked frames, so a single read()
    // deterministically sees only ': connected'. Accumulate until the event shows
    // up, with a `done` guard so a regression fails instead of hanging.
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    while (!seen.includes('"relPath":"notes.md"')) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }
    await reader.cancel()

    expect(seen).toContain('"relPath":"notes.md"')
    expect(seen).toContain('"type":"changed"')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- cli/server.test.ts`
Expected: FAIL — cannot resolve `./server.js`.

- [ ] **Step 3: Implement `cli/server.ts`**

```ts
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import type { WatchEvent } from './types.js'
import { ConflictError, NotFoundError, PathError, type Workspace } from './workspace.js'

export interface ServerOptions {
  workspace: Workspace
  /** Absolute path to the built app bundle. */
  distDir: string
  /** 0 (default) lets the OS assign an ephemeral port. */
  port?: number
  host?: string
  /**
   * Operator log sink. Injected so tests can assert what was logged and keep
   * their own output pristine; defaults to stderr. Never receives the token.
   */
  log?: (message: string) => void
}

export interface ServerHandle {
  /** Origin plus the token query param — hand this to the browser. */
  url: string
  origin: string
  port: number
  token: string
  notify(event: WatchEvent): void
  close(): Promise<void>
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** True when `candidate` is outside `dir`. Segment-wise, so '..foo.js' is fine. */
function escapesDir(dir: string, candidate: string): boolean {
  const rel = path.relative(dir, candidate)
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)
}

/** Client errors that a handler raises and the top-level mapper turns into 4xx. */
export class BadRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message)
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readBody(req: http.IncomingMessage, limitBytes = 8 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    // 413, not 500 — an oversize body is the client's mistake, not a server fault.
    if (total > limitBytes) throw new BadRequestError('request body too large', 413)
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const { workspace, distDir } = options
  const host = options.host ?? '127.0.0.1'
  const log = options.log ?? ((message: string) => process.stderr.write(`better-md: ${message}\n`))
  const token = crypto.randomBytes(32).toString('hex')
  const realDist = await fsp.realpath(distDir)
  const clients = new Set<http.ServerResponse>()

  let origin = ''

  /** Same-origin requests may omit Origin; anything cross-site always sends it. */
  function originAllowed(req: http.IncomingMessage): boolean {
    const value = req.headers.origin
    if (value === undefined) return true
    return value === origin
  }

  function tokenAllowed(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    // RFC 7235 makes the scheme token case-insensitive.
    const match = /^Bearer[ ]+(.+)$/i.exec(header)
    if (match === null) return false
    return timingSafeEqualStr(match[1], token)
  }

  async function serveStatic(res: http.ServerResponse, urlPath: string): Promise<void> {
    let relative: string
    if (urlPath === '/') {
      relative = 'index.html'
    } else {
      try {
        relative = decodeURIComponent(urlPath.slice(1))
      } catch {
        // A malformed escape like /%zz is a bad request, not a server fault.
        // This route has no auth gate, so letting it reach the 500 handler would
        // let any page flood the terminal the CLI is drawing in, one line per
        // request. Answer 400 and log nothing.
        sendJson(res, 400, { error: 'malformed asset path' })
        return
      }
    }

    const abs = path.resolve(realDist, relative)
    // Segment-wise, so a legitimate '..foo.js' is not caught by a bare prefix test.
    if (escapesDir(realDist, abs)) {
      sendJson(res, 400, { error: 'invalid asset path' })
      return
    }

    // Lexical confinement is not enough: readFile follows symlinks, so a link
    // inside dist/ would serve a file from anywhere. Workspace.confineReal
    // resolves symlinks for documents; the asset layer must agree rather than
    // being the weaker of the two.
    let real: string
    try {
      real = await fsp.realpath(abs)
    } catch {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (escapesDir(realDist, real)) {
      sendJson(res, 400, { error: 'invalid asset path' })
      return
    }

    try {
      const body = await fsp.readFile(real)
      res.writeHead(200, {
        'content-type':
          CONTENT_TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        // The bundle is ours, but these cost nothing and keep a stray asset from
        // being sniffed into something executable.
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      res.end(body)
    } catch {
      sendJson(res, 404, { error: 'not found' })
    }
  }

  async function handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    if (!originAllowed(req)) {
      sendJson(res, 403, { error: 'origin not allowed' })
      return
    }
    if (!tokenAllowed(req)) {
      sendJson(res, 401, { error: 'missing or invalid token' })
      return
    }

    if (url.pathname === '/api/workspace' && req.method === 'GET') {
      sendJson(res, 200, { files: workspace.list(), active: workspace.active })
      return
    }

    if (url.pathname === '/api/doc' && req.method === 'GET') {
      const relPath = url.searchParams.get('path')
      if (relPath === null) {
        sendJson(res, 400, { error: 'missing path parameter' })
        return
      }
      sendJson(res, 200, await workspace.read(relPath))
      return
    }

    if (url.pathname === '/api/doc' && req.method === 'PUT') {
      const raw = await readBody(req)
      let parsed: { relPath?: unknown; content?: unknown; baseMtimeMs?: unknown }
      try {
        parsed = JSON.parse(raw) as typeof parsed
      } catch {
        sendJson(res, 400, { error: 'body must be JSON' })
        return
      }
      if (typeof parsed.relPath !== 'string' || typeof parsed.content !== 'string') {
        sendJson(res, 400, { error: 'relPath and content are required strings' })
        return
      }
      // Validate rather than coerce. `Number(x)` turns a non-numeric body field
      // into NaN, and NaN compares false against every conflict check — which
      // would let a request overwrite a document without knowing its mtime.
      // Workspace.write also guards this; rejecting here keeps the 400 honest.
      let base: number | null
      if (parsed.baseMtimeMs === null || parsed.baseMtimeMs === undefined) {
        base = null
      } else if (typeof parsed.baseMtimeMs === 'number' && Number.isFinite(parsed.baseMtimeMs)) {
        base = parsed.baseMtimeMs
      } else {
        sendJson(res, 400, { error: 'baseMtimeMs must be null or a finite number' })
        return
      }
      try {
        sendJson(res, 200, await workspace.write(parsed.relPath, parsed.content, base))
      } catch (err) {
        if (err instanceof ConflictError) {
          // Re-read to hand the client their version. If it vanished entirely,
          // there is no "theirs" to send — report the conflict without content.
          try {
            const theirs = await workspace.read(parsed.relPath)
            sendJson(res, 409, {
              error: err.message,
              theirContent: theirs.content,
              theirMtimeMs: theirs.mtimeMs,
            })
          } catch {
            sendJson(res, 409, { error: err.message, theirContent: null, theirMtimeMs: null })
          }
          return
        }
        throw err
      }
      return
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    sendJson(res, 404, { error: 'unknown endpoint' })
  }

  const server = http.createServer((req, res) => {
    // Parse defensively. This runs synchronously inside the listener, so a throw
    // here is NOT caught by done.catch below — it becomes an uncaughtException and
    // kills the CLI mid-session. A request target the WHATWG parser rejects (e.g.
    // `GET //[::1`, reachable over a raw socket) did exactly that.
    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${host}`)
    } catch {
      sendJson(res, 400, { error: 'malformed request target' })
      return
    }

    const done = url.pathname.startsWith('/api/')
      ? handleApi(req, res, url)
      : serveStatic(res, url.pathname)

    done.catch((err: unknown) => {
      // Classify first so the operator still learns about an unexpected failure
      // even when the response is already partly on the wire and only res.end()
      // is possible below.
      const isExpected =
        err instanceof BadRequestError || err instanceof PathError || err instanceof NotFoundError
      if (!isExpected) {
        log(`unhandled request error: ${err instanceof Error ? err.message : String(err)}`)
      }

      // Never write headers twice, whatever the failure was.
      if (res.headersSent) {
        res.end()
        return
      }
      if (err instanceof BadRequestError) {
        sendJson(res, err.status, { error: err.message })
        return
      }
      if (err instanceof PathError) {
        sendJson(res, 400, { error: err.message })
        return
      }
      // A missing document is a routine 404, not a server fault. Without this the
      // workspace's NotFoundError would surface as a 500.
      if (err instanceof NotFoundError) {
        sendJson(res, 404, { error: err.message })
        return
      }
      // Already logged above. Never return the detail: raw errno messages embed
      // absolute paths (Workspace.write lets EACCES through from fs.writeFile),
      // which would disclose where the workspace lives.
      sendJson(res, 500, { error: 'internal server error' })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, resolve)
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a TCP port')
  }
  const port = address.port
  origin = `http://${host}:${port}`

  return {
    origin,
    port,
    token,
    url: `${origin}/?t=${token}`,
    notify(event: WatchEvent): void {
      const frame = `data: ${JSON.stringify(event)}\n\n`
      for (const client of clients) client.write(frame)
    },
    async close(): Promise<void> {
      for (const client of clients) client.end()
      clients.clear()
      // server.close() only stops accepting and then waits for existing
      // connections to finish. A client that sent headers but no body, or an
      // aborted SSE stream, keeps it pending indefinitely — which would make
      // Ctrl-C look like a hang, since index.ts wires SIGINT straight to this.
      // Destroy what is left rather than waiting on it.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- cli/server.test.ts`
Expected: PASS — **24 tests**, composed as: static serving 5 (index, assets, traversal,
malformed escape, symlink-out-of-dist) + API authentication 5 (including a same-length wrong
token, the only input that reaches crypto.timingSafeEqual) + document API 9 (list, read,
traversal path, save, 409, 404, and 3 `it.each` rows) + shutdown 1 + malformed request targets 2
(`it.each` rows, raw socket) + error handling 1 + events 1.

Verify by enumerating names, not arithmetic. If your run reports a different total, report the
discrepancy and which case did not register — do not adjust the count or a test to match. An
earlier task had a controller miscount here, and a later one had two tests that could not
exercise their target at all.

- [ ] **Step 5: Run the full suite, typecheck, and lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add cli/server.ts cli/server.test.ts
git commit -m "feat(cli): add HTTP server with token auth, doc API, and SSE"
```

---

### Task 6: CLI entry point

**Files:**

- Create: `cli/index.ts`, `cli/open.ts`
- Modify: `cli/server.ts` (`close()` only), `cli/server.test.ts` (one new test), `README.md`

**Interfaces:**

- Consumes: everything from tasks 1-5.
- Produces: the `better-md` executable. `openBrowser(url: string): void` from `./open.js`.

- [ ] **Step 0: Make `ServerHandle.close()` actually finish**

This task wires `SIGINT` to `close()`, so a `close()` that never settles reads to the
user as Ctrl-C hanging the terminal. Review of Task 5 measured exactly that: with a
client that had sent request headers but no body, or after an aborted SSE stream,
`close()` was still pending after 3 seconds, because `server.close()` stops accepting
and then _waits_ for existing connections.

Apply the amended `close()` from Task 5's Step 3 code block (it now calls
`server.closeAllConnections()` after registering the close callback), and add the
`describe('shutdown')` test from Task 5's Step 1 block, which opens a half-sent request
and asserts `close()` returns in under a second.

Do this first: everything else in this task depends on teardown working.

- [ ] **Step 1: Implement `cli/open.ts`**

```ts
import { spawn } from 'node:child_process'

/**
 * Best-effort browser launch. Failure is never fatal — the caller always prints
 * the URL, so the user can open it by hand.
 */
export function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  const args = process.platform === 'win32' ? ['', url] : [url]
  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Ignored: the URL is printed regardless.
  }
}
```

- [ ] **Step 2: Implement `cli/index.ts`**

```ts
#!/usr/bin/env node
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCliArgs, UsageError } from './args.js'
import { openBrowser } from './open.js'
import { ResolveError, resolveWorkspace } from './resolve.js'
import { startServer } from './server.js'
import { watchWorkspace } from './watch.js'
import { Workspace } from './workspace.js'

/** dist-cli/index.js → repo root → dist/ */
function findDistDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2))
  const descriptor = await resolveWorkspace(options)
  const workspace = new Workspace(descriptor)

  const distDir = findDistDir()
  try {
    await fsp.access(path.join(distDir, 'index.html'))
  } catch {
    throw new ResolveError(`app bundle not found at ${distDir}. Run \`pnpm build\` first.`)
  }

  let server: Awaited<ReturnType<typeof startServer>>
  try {
    server = await startServer({ workspace, distDir, port: options.port })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new ResolveError(
        `port ${options.port} is already in use. Omit --port to let the OS pick a free one.`
      )
    }
    throw err
  }

  const stopWatching = watchWorkspace(workspace.root, (event) => server.notify(event))

  process.stdout.write(`better-md serving ${workspace.root}\n`)
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
          `better-md: shutdown error: ${err instanceof Error ? err.message : String(err)}\n`
        )
      })
      .finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err: unknown) => {
  if (err instanceof UsageError || err instanceof ResolveError) {
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  }
  process.stderr.write(`better-md: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```

- [ ] **Step 3: Build and verify the error paths by hand**

```bash
pnpm build && pnpm build:cli
node dist-cli/index.js --help              # usage text, exit 1
node dist-cli/index.js /nope/missing.md    # "no such file or directory", exit 1
node dist-cli/index.js --plan --port abc   # port error, exit 1
```

Expected: each prints a single readable line (or the usage block) with no stack trace.

- [ ] **Step 4: Verify the happy path serves real files**

```bash
mkdir -p /tmp/bmd-smoke && printf '# hello\n' > /tmp/bmd-smoke/hello.md
node dist-cli/index.js --no-open --port 7391 /tmp/bmd-smoke > /tmp/bmd-smoke/out.txt 2>&1 &
sleep 1
TOKEN=$(sed -n 's|.*/?t=\([a-f0-9]*\).*|\1|p' /tmp/bmd-smoke/out.txt)
echo "no token:"; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7391/api/workspace
echo "bad origin:"; curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" -H 'Origin: https://evil.example' http://127.0.0.1:7391/api/workspace
echo "with token:"; curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7391/api/workspace
kill %1
```

Expected: `401`, then `403`, then
`{"files":[{"name":"hello.md","relPath":"hello.md"}],"active":"hello.md"}`.

- [ ] **Step 4b: Confirm the declared `bin` target is actually executable**

`package.json` declares `"bin": {"better-md": "./dist-cli/index.js"}`, but `tsc` emits
mode `644`, so a user who `pnpm link`s or installs globally and runs the bare `better-md`
command gets `EACCES` — the shebang is correct but the file cannot be executed. The
`build:cli` script now chmods it via a Node one-liner (portable; plain `chmod` would fail
on Windows).

```bash
pnpm build:cli
ls -l dist-cli/index.js          # expect -rwxr-xr-x
./dist-cli/index.js --help       # must run WITHOUT an explicit `node` prefix
```

- [ ] **Step 5: Add a CLI usage section to `README.md`**

Insert the following after the existing "Getting started" section. The outer fence uses
tildes so the inner triple-backtick block cannot terminate it early — do not convert it
to backticks.

````markdown
## Opening files from disk

Build once, then point the CLI at a file or directory:

```bash
pnpm build                     # the CLI serves the built bundle
node dist-cli/index.js notes.md
```

- `better-md <file.md>` — open a single file
- `better-md <directory>` — open every markdown file in a directory
- `better-md --plan` — open Claude Code's plans from `~/.claude/plans`, newest first

Edits save back to the real file with `Cmd/Ctrl+S`. If the file changes on disk while you
have no unsaved edits, the view refreshes automatically; if you do have unsaved edits, a
banner lets you keep yours or take theirs.
````

- [ ] **Step 6: Commit**

```bash
git add cli/index.ts cli/open.ts README.md
git commit -m "feat(cli): add better-md entry point"
```

---

### Task 7: DocSource interface and LocalDocSource

Introduces the abstraction with **no behavior change** — `LocalDocSource` reproduces exactly what `App.tsx` does today.

**Files:**

- Create: `src/lib/docSource.ts`, `src/lib/docSource.test.ts`
- Modify: `src/types.ts`

**Interfaces:**

- Consumes: `FileDoc` from `../types`; samples from `./samples`.
- Produces: `DocSource`, `DocFile`, `DocListing`, `DocRead`, `SaveResult`, `ChangeEvent`, `StatusEvent`, `SourceEvent`, `class LocalDocSource`.

- [ ] **Step 1: Extend `FileDoc` in `src/types.ts`**

```ts
export interface FileDoc {
  id: string
  name: string
  content: string
  /** Path relative to the CLI workspace root, when disk-backed. */
  relPath?: string
}
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/docSource.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { LocalDocSource } from './docSource'

describe('LocalDocSource', () => {
  it('cannot save', () => {
    expect(new LocalDocSource().canSave).toBe(false)
  })

  it('lists the sample documents and activates the README', async () => {
    const listing = await new LocalDocSource().list()
    expect(listing.files.map((f) => f.relPath)).toEqual(['README.md', 'notes.md', 'todo.md'])
    expect(listing.active).toBe('README.md')
    expect(listing.files[0].content.length).toBeGreaterThan(0)
    // Not disk-backed, so there is no mtime to compare saves against.
    expect(listing.files.every((f) => f.mtimeMs === null)).toBe(true)
  })

  it('reads a listed document', async () => {
    const source = new LocalDocSource()
    const listing = await source.list()
    const doc = await source.read('README.md')
    expect(doc.content).toBe(listing.files[0].content)
    expect(doc.mtimeMs).toBeNull()
  })

  it('rejects reads of unknown documents', async () => {
    await expect(new LocalDocSource().read('nope.md')).rejects.toThrow()
  })

  it('reports save as unsupported rather than throwing', async () => {
    const result = await new LocalDocSource().save('README.md', 'x', null)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('error')
  })

  it('returns a no-op unsubscribe', () => {
    const unsubscribe = new LocalDocSource().subscribe(() => {})
    expect(() => unsubscribe()).not.toThrow()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test -- src/lib/docSource.test.ts`
Expected: FAIL — cannot resolve `./docSource`.

- [ ] **Step 4: Implement `src/lib/docSource.ts`**

```ts
import { SAMPLE_NOTES, SAMPLE_README, SAMPLE_TODO } from './samples'

export interface DocFile {
  name: string
  relPath: string
  content: string
  /**
   * mtime the content was read at, or null when not disk-backed. Carried here
   * so a listing is self-sufficient: the save conflict check needs it, and
   * re-fetching it would both duplicate requests and leave a window where a
   * save is wrongly treated as a new-file create.
   */
  mtimeMs: number | null
}

export interface DocRead {
  content: string
  /** null when the document is not backed by a file on disk. */
  mtimeMs: number | null
}

export interface SaveOk {
  ok: true
  mtimeMs: number | null
}

export interface SaveConflict {
  ok: false
  reason: 'conflict'
  /**
   * The on-disk version, or null when the document vanished entirely — the
   * server sends null for that case. Deliberately NOT coalesced to '': a
   * "take theirs" action on an empty string would overwrite the user's text
   * with nothing. null means "there is no theirs", which the UI must handle
   * as keep-yours rather than as an empty document.
   */
  theirContent: string | null
  theirMtimeMs: number | null
}

export interface SaveFailed {
  ok: false
  reason: 'error'
  message: string
}

export type SaveResult = SaveOk | SaveConflict | SaveFailed

export interface DocListing {
  files: DocFile[]
  /** relPath to open first. For --plan this is the newest plan, not the first. */
  active: string
}

export interface ChangeEvent {
  type: 'changed' | 'removed'
  relPath: string
}

/** Emitted when the live-update channel connects or drops. */
export interface StatusEvent {
  type: 'connected' | 'disconnected'
}

export type SourceEvent = ChangeEvent | StatusEvent

/** Where documents come from, and whether they can go back. */
export interface DocSource {
  canSave: boolean
  list(): Promise<DocListing>
  read(relPath: string): Promise<DocRead>
  save(relPath: string, content: string, baseMtimeMs: number | null): Promise<SaveResult>
  /** Returns an unsubscribe function. */
  subscribe(callback: (event: SourceEvent) => void): () => void
}

const SAMPLES: DocFile[] = [
  { name: 'README.md', relPath: 'README.md', content: SAMPLE_README, mtimeMs: null },
  { name: 'notes.md', relPath: 'notes.md', content: SAMPLE_NOTES, mtimeMs: null },
  { name: 'todo.md', relPath: 'todo.md', content: SAMPLE_TODO, mtimeMs: null },
]

/** Browser-only mode: seeded samples, in-memory, export-to-download. */
export class LocalDocSource implements DocSource {
  readonly canSave = false

  private docs: DocFile[] = SAMPLES.map((doc) => ({ ...doc }))

  async list(): Promise<DocListing> {
    return { files: this.docs.map((doc) => ({ ...doc })), active: 'README.md' }
  }

  async read(relPath: string): Promise<DocRead> {
    const doc = this.docs.find((d) => d.relPath === relPath)
    if (doc === undefined) throw new Error(`unknown document: ${relPath}`)
    return { content: doc.content, mtimeMs: null }
  }

  async save(): Promise<SaveResult> {
    return {
      ok: false,
      reason: 'error',
      message: 'This document is not backed by a file on disk. Use Export instead.',
    }
  }

  subscribe(): () => void {
    return () => {}
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- src/lib/docSource.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/docSource.ts src/lib/docSource.test.ts src/types.ts
git commit -m "feat(app): add DocSource abstraction with in-memory implementation"
```

---

### Task 8: ServerDocSource

**Files:**

- Create: `src/lib/serverDocSource.ts`, `src/lib/serverDocSource.test.ts`

**Interfaces:**

- Consumes: `DocSource`, `DocListing`, `DocRead`, `SaveResult`, `SourceEvent` from `./docSource`.
- Produces: `class ServerDocSource` with `constructor(origin: string, token: string, fetchImpl?: typeof fetch)`. Emits `{type:'connected'}` on stream open and `{type:'disconnected'}` on drop, so the UI can stop claiming the view is live.

SSE is consumed via `fetch` + a stream reader rather than `EventSource`, because `EventSource` cannot set an `Authorization` header — and header-only auth is what makes cross-site forgery impossible.

- [ ] **Step 1: Write the failing test**

Create `src/lib/serverDocSource.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import type { SourceEvent } from './docSource'
import { ServerDocSource } from './serverDocSource'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('ServerDocSource', () => {
  it('can save', () => {
    expect(new ServerDocSource('http://127.0.0.1:1', 'tok', vi.fn()).canSave).toBe(true)
  })

  it('sends the bearer token when listing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ files: [{ name: 'a.md', relPath: 'a.md' }], active: 'a.md' })
    )
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    await source.list()

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })

  it('preloads content for every listed file and preserves the active file', async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.includes('/api/workspace')) {
        return jsonResponse({
          files: [
            { name: 'a.md', relPath: 'a.md' },
            { name: 'b.md', relPath: 'b.md' },
          ],
          // The server activates the newest plan, not the first alphabetically.
          active: 'b.md',
        })
      }
      const relPath = new URL(input).searchParams.get('path')
      return jsonResponse({ relPath, content: `body of ${relPath}`, mtimeMs: 100 })
    })
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const listing = await source.list()

    expect(listing.files).toEqual([
      { name: 'a.md', relPath: 'a.md', content: 'body of a.md', mtimeMs: 100 },
      { name: 'b.md', relPath: 'b.md', content: 'body of b.md', mtimeMs: 100 },
    ])
    expect(listing.active).toBe('b.md')

    // One /api/workspace + one /api/doc per file, and no more. Without this the
    // test would still pass if someone reintroduced a separate mtime fetch —
    // the exact regression the mtimeMs-in-listing design exists to prevent.
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('returns ok on a successful save', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ mtimeMs: 999 }))
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const result = await source.save('a.md', 'text', 100)

    expect(result).toEqual({ ok: true, mtimeMs: 999 })
  })

  it('maps a 409 to a conflict result', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ theirContent: 'theirs', theirMtimeMs: 500 }, 409)
    )
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const result = await source.save('a.md', 'mine', 100)

    expect(result).toEqual({
      ok: false,
      reason: 'conflict',
      theirContent: 'theirs',
      theirMtimeMs: 500,
    })
  })

  it('maps a 500 to an error result carrying the message', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'disk full' }, 500))
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const result = await source.save('a.md', 'mine', 100)

    expect(result).toEqual({ ok: false, reason: 'error', message: 'disk full' })
  })

  it('maps a rejected fetch to an error result', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const result = await source.save('a.md', 'mine', 100)

    expect(result).toEqual({ ok: false, reason: 'error', message: 'network down' })
  })

  it('parses SSE frames into change events', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(': connected\n\ndata: {"type":"changed","relPath":"a.md"}\n\n')
        )
        controller.close()
      },
    })
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }))
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const seen: SourceEvent[] = []
    const unsubscribe = source.subscribe((event) => seen.push(event))
    await vi.waitFor(() => expect(seen.some((e) => e.type === 'changed')).toBe(true))
    unsubscribe()

    // 'connected' lands first so the UI can show a live indicator.
    expect(seen[0]).toEqual({ type: 'connected' })
    expect(seen.find((e) => e.type === 'changed')).toEqual({ type: 'changed', relPath: 'a.md' })
  })

  it('cancels the reconnect backoff timer on unsubscribe', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }))
      const source = new ServerDocSource(
        'http://127.0.0.1:1',
        'tok',
        fetchImpl as unknown as typeof fetch
      )

      const seen: SourceEvent[] = []
      const unsubscribe = source.subscribe((event) => seen.push(event))

      // Let the failing fetch settle so the loop reaches its backoff sleep.
      await vi.advanceTimersByTimeAsync(0)
      expect(seen).toContainEqual({ type: 'disconnected' })
      expect(vi.getTimerCount()).toBe(1)

      unsubscribe()

      // The point: cancelled, not merely muted. Without clearTimeout the timer
      // would still be pending here and `stopped` would only block the next
      // iteration — indistinguishable from correct behaviour by any other
      // assertion.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes a null theirContent through instead of inventing empty content', async () => {
    // The server sends theirContent: null when the document vanished entirely.
    // Coalescing that to '' would let a "take theirs" action overwrite the
    // user's text with nothing, so null must survive the mapping.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'gone', theirContent: null, theirMtimeMs: null }, 409)
    )
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const result = await source.save('a.md', 'mine', 100)

    expect(result).toEqual({
      ok: false,
      reason: 'conflict',
      theirContent: null,
      theirMtimeMs: null,
    })
  })

  it('reports disconnection when the stream fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }))
    const source = new ServerDocSource(
      'http://127.0.0.1:1',
      'tok',
      fetchImpl as unknown as typeof fetch
    )

    const seen: SourceEvent[] = []
    const unsubscribe = source.subscribe((event) => seen.push(event))
    await vi.waitFor(() => expect(seen.some((e) => e.type === 'disconnected')).toBe(true))
    unsubscribe()

    expect(seen).toContainEqual({ type: 'disconnected' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/lib/serverDocSource.test.ts`
Expected: FAIL — cannot resolve `./serverDocSource`.

- [ ] **Step 3: Implement `src/lib/serverDocSource.ts`**

```ts
import type { DocListing, DocRead, DocSource, SaveResult, SourceEvent } from './docSource'

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 10_000

/** Disk-backed source: every call carries the bearer token. */
export class ServerDocSource implements DocSource {
  readonly canSave = true

  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly origin: string,
    private readonly token: string,
    fetchImpl?: typeof fetch
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra }
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: this.headers(init?.headers as Record<string, string>),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `request failed with ${res.status}`)
    }
    return (await res.json()) as T
  }

  async list(): Promise<DocListing> {
    const listing = await this.json<{
      files: Array<{ name: string; relPath: string }>
      active: string
    }>(`${this.origin}/api/workspace`)
    const files = await Promise.all(
      listing.files.map(async (file) => {
        // read() already returns the mtime — keep it rather than re-fetching.
        const doc = await this.read(file.relPath)
        return {
          name: file.name,
          relPath: file.relPath,
          content: doc.content,
          mtimeMs: doc.mtimeMs,
        }
      })
    )
    return { files, active: listing.active }
  }

  async read(relPath: string): Promise<DocRead> {
    const doc = await this.json<{ content: string; mtimeMs: number }>(
      `${this.origin}/api/doc?path=${encodeURIComponent(relPath)}`
    )
    return { content: doc.content, mtimeMs: doc.mtimeMs }
  }

  async save(relPath: string, content: string, baseMtimeMs: number | null): Promise<SaveResult> {
    try {
      const res = await this.fetchImpl(`${this.origin}/api/doc`, {
        method: 'PUT',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ relPath, content, baseMtimeMs }),
      })
      if (res.status === 409) {
        const body = (await res.json()) as {
          theirContent: string | null
          theirMtimeMs: number | null
        }
        return {
          ok: false,
          reason: 'conflict',
          theirContent: body.theirContent,
          theirMtimeMs: body.theirMtimeMs,
        }
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        return { ok: false, reason: 'error', message: body.error ?? `save failed (${res.status})` }
      }
      const body = (await res.json()) as { mtimeMs: number }
      return { ok: true, mtimeMs: body.mtimeMs }
    } catch (err) {
      return {
        ok: false,
        reason: 'error',
        message: err instanceof Error ? err.message : 'save failed',
      }
    }
  }

  /**
   * Consume the SSE stream with fetch so the Authorization header can be set —
   * EventSource cannot send custom headers.
   */
  subscribe(callback: (event: SourceEvent) => void): () => void {
    let stopped = false
    let attempt = 0
    let controller: AbortController | null = null
    let backoffTimer: ReturnType<typeof setTimeout> | null = null

    const run = async (): Promise<void> => {
      while (!stopped) {
        controller = new AbortController()
        try {
          const res = await this.fetchImpl(`${this.origin}/api/events`, {
            headers: this.headers(),
            signal: controller.signal,
          })
          if (!res.ok || res.body === null) throw new Error(`events failed (${res.status})`)
          attempt = 0
          callback({ type: 'connected' })
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (!stopped) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const frames = buffer.split('\n\n')
            buffer = frames.pop() ?? ''
            for (const frame of frames) {
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue
                try {
                  callback(JSON.parse(line.slice(5).trim()) as ChangeEvent)
                } catch {
                  // Ignore malformed frames rather than tearing down the stream.
                }
              }
            }
          }
        } catch {
          // Fall through to the backoff below.
        }
        if (stopped) return

        // Inside a try: a subscriber callback that throws must not become an
        // unhandled rejection out of the fire-and-forget `void run()` below.
        try {
          callback({ type: 'disconnected' })
        } catch {
          // A broken subscriber is not the stream's problem.
        }

        attempt += 1
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS)
        // Hold the handle so unsubscribe can cancel it. `stopped` alone would
        // stop the next iteration, but the timer itself would stay pending —
        // the same "muted, not cancelled" gap the watcher had to fix earlier in
        // this plan, and in a browser a repeatedly mounted component would
        // accumulate one live timer per unsubscribe.
        await new Promise<void>((resolve) => {
          backoffTimer = setTimeout(() => {
            backoffTimer = null
            resolve()
          }, delay)
        })
      }
    }

    void run()

    return () => {
      stopped = true
      controller?.abort()
      if (backoffTimer !== null) {
        clearTimeout(backoffTimer)
        backoffTimer = null
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- src/lib/serverDocSource.test.ts`
Expected: PASS — 11 tests. Enumerate names; report a discrepancy rather than adjusting.

- [ ] **Step 5: Commit**

```bash
git add src/lib/serverDocSource.ts src/lib/serverDocSource.test.ts
git commit -m "feat(app): add ServerDocSource backed by the CLI API"
```

---

### Task 9: Source detection and boot wiring

**Files:**

- Create: `src/lib/detectSource.ts`, `src/lib/detectSource.test.ts`

**Interfaces:**

- Consumes: `LocalDocSource` from `./docSource`; `ServerDocSource` from `./serverDocSource`.
- Produces: `detectSource(origin: string, search: string): DocSource`.

`src/main.tsx` is deliberately **not** touched here — `App` cannot accept a `source`
prop until Task 10, and wiring it early would leave the tree red between tasks.

- [ ] **Step 1: Write the failing test**

Create `src/lib/detectSource.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { detectSource } from './detectSource'
import { LocalDocSource } from './docSource'

describe('detectSource', () => {
  it('returns a saving source when a token is present', () => {
    expect(detectSource('http://127.0.0.1:5173', '?t=abc123').canSave).toBe(true)
  })

  // instanceof proves the right class but says nothing about the arguments: a
  // swapped `new ServerDocSource(token, origin)` or a hardcoded token would pass
  // every other test here. Only observing an actual request settles it.
  it('constructs the server source with the given origin and token', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ files: [], active: '' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl as unknown as typeof fetch
    try {
      await detectSource('http://127.0.0.1:4321', '?t=abc123').list()
    } finally {
      globalThis.fetch = original
    }

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:4321/api/workspace')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer abc123')
  })

  it('falls back to the local source for a whitespace-only token', () => {
    expect(detectSource('http://127.0.0.1:5173', '?t=%20')).toBeInstanceOf(LocalDocSource)
  })

  it('returns the local source when no token is present', () => {
    expect(detectSource('http://127.0.0.1:5173', '').canSave).toBe(false)
  })

  it('ignores an empty token', () => {
    expect(detectSource('http://127.0.0.1:5173', '?t=').canSave).toBe(false)
  })

  it('ignores unrelated query parameters', () => {
    expect(detectSource('http://127.0.0.1:5173', '?theme=dark').canSave).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/lib/detectSource.test.ts`
Expected: FAIL — cannot resolve `./detectSource`.

- [ ] **Step 3: Implement `src/lib/detectSource.ts`**

```ts
import { LocalDocSource, type DocSource } from './docSource'
import { ServerDocSource } from './serverDocSource'

/**
 * Choose a document source from the boot URL. A token means the page was opened
 * by the CLI; without one the app behaves exactly as the browser-only build.
 */
export function detectSource(origin: string, search: string): DocSource {
  // Trim before testing: a whitespace-only token (?t=%20) is neither null nor
  // empty, so it would otherwise build a ServerDocSource whose every request
  // 401s — a broken app, when the whole point of this branch is that anything
  // other than a real token yields the working browser-only one.
  const token = new URLSearchParams(search).get('t')?.trim() ?? ''
  if (token === '') return new LocalDocSource()
  return new ServerDocSource(origin, token)
}
```

- [ ] **Step 4: Run the tests and the full suite**

Run: `pnpm test -- src/lib/detectSource.test.ts && pnpm typecheck && pnpm lint`
Expected: 6 tests pass; typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/detectSource.ts src/lib/detectSource.test.ts
git commit -m "feat(app): detect the CLI token at boot and pick a document source"
```

---

### Task 10: Disk-backed mode in App — loading, dirty tracking, save

**Files:**

- Modify: `src/types.ts`, `src/App.tsx:9-49`, `src/main.tsx`
- Create: `src/ui/ConflictBanner.tsx`

**Interfaces:**

- Consumes: `DocSource`, `DocListing`, `SaveResult`, `SourceEvent` from `../lib/docSource`; `detectSource` from `./lib/detectSource`.
- Produces: `App` accepting a required `source: DocSource` prop; `ConflictBanner` and `SaveErrorBanner` components.

- [ ] **Step 1: Extend `Props` and `State` in `src/types.ts`**

Add the import and fields:

```ts
import type { DocSource } from './lib/docSource'

export interface Props {
  source: DocSource
  defaultTheme?: Theme
  defaultLayout?: Layout
  accentColor?: string
  syncScroll?: boolean
}

export interface ConflictState {
  relPath: string
  /** null when the document vanished on disk — there is no "theirs" to take. */
  theirContent: string | null
  theirMtimeMs: number | null
}

export interface State {
  files: FileDoc[]
  activeId: string
  md: string
  theme: Theme
  layout: Layout
  focusPane: Pane
  editingSide: Side
  dragOver: boolean
  /** id of the file whose name is being edited inline, or null. */
  renamingId: string | null
  /** True until the first list() resolves. */
  loading: boolean
  /** relPath → has unsaved edits. */
  dirty: Record<string, boolean>
  /** relPath → mtime the content was loaded at, or null for non-disk docs. */
  baseMtimeMs: Record<string, number | null>
  conflict: ConflictState | null
  saveError: string | null
  /** False while the live-update channel is down, so the UI stops implying it is live. */
  watching: boolean
}
```

- [ ] **Step 2: Create `src/ui/ConflictBanner.tsx`**

```tsx
interface ConflictBannerProps {
  fileName: string
  onKeepMine: () => void
  onTakeTheirs: () => void
}

export function ConflictBanner({
  fileName,
  onKeepMine,
  onTakeTheirs,
}: ConflictBannerProps): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm"
      style={{ background: 'var(--code-bg)', borderColor: 'var(--border)' }}
    >
      <span>
        <strong>{fileName}</strong> changed on disk and you have unsaved edits.
      </span>
      <button type="button" onClick={onKeepMine} className="underline">
        Keep mine
      </button>
      <button type="button" onClick={onTakeTheirs} className="underline">
        Take theirs
      </button>
    </div>
  )
}

interface SaveErrorBannerProps {
  message: string
  onDismiss: () => void
}

export function SaveErrorBanner({ message, onDismiss }: SaveErrorBannerProps): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm"
      style={{ background: 'var(--code-bg)', borderColor: 'var(--border)' }}
    >
      <span>Could not save: {message}</span>
      <button type="button" onClick={onDismiss} className="underline">
        Dismiss
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Replace the constructor and mount logic in `src/App.tsx:24-49`**

```tsx
  constructor(props: Props) {
    super(props)
    const layout: Layout =
      props.defaultLayout && ['studio', 'tabs', 'focus'].includes(props.defaultLayout)
        ? props.defaultLayout
        : 'studio'
    this.state = {
      files: [],
      activeId: '',
      md: '',
      theme: props.defaultTheme === 'dark' ? 'dark' : 'light',
      layout,
      focusPane: 'edit',
      editingSide: 'init',
      dragOver: false,
      renamingId: null,
      loading: true,
      dirty: {},
      baseMtimeMs: {},
      conflict: null,
      saveError: null,
      watching: !props.source.canSave,
    }
  }

  private unsubscribe: (() => void) | null = null

  componentDidMount(): void {
    void this.loadFromSource()
    document.addEventListener('keydown', this.onGlobalKey)
    window.addEventListener('beforeunload', this.onBeforeUnload)
    this.unsubscribe = this.props.source.subscribe(this.onExternalChange)
    this.renderPreview()
  }

  componentWillUnmount(): void {
    document.removeEventListener('keydown', this.onGlobalKey)
    window.removeEventListener('beforeunload', this.onBeforeUnload)
    this.unsubscribe?.()
  }

  /**
   * Warn before discarding unsaved edits to real files. Save is explicit by
   * design, so without this an accidental Cmd+W silently throws away edits to
   * something like a plan in ~/.claude/plans. Only meaningful when the source
   * can save; the browser-only app has nothing on disk to lose.
   */
  onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (!this.props.source.canSave) return
    if (!Object.values(this.state.dirty).some(Boolean)) return
    e.preventDefault()
    // Legacy assignment: some browsers still require it to show the prompt.
    e.returnValue = ''
  }

  /** Populate files from the source. Runs once on mount. */
  private async loadFromSource(): Promise<void> {
    const listing = await this.props.source.list()
    const files: FileDoc[] = listing.files.map((doc) => ({
      id: newId(),
      name: doc.name,
      content: doc.content,
      relPath: doc.relPath,
    }))
    if (files.length === 0) {
      this.setState({ loading: false })
      return
    }
    // Honour the source's chosen active document — for --plan that is the
    // newest plan, which is the whole point of the flag.
    const active = files.find((f) => f.relPath === listing.active) ?? files[0]
    // Seed the conflict-check baselines from the listing itself, so a save
    // immediately after boot compares against a real mtime rather than null
    // (which write() would interpret as "create a new file" and reject).
    const baseMtimeMs: Record<string, number | null> = {}
    for (const doc of listing.files) baseMtimeMs[doc.relPath] = doc.mtimeMs
    // flushSync so a source that resolves immediately commits before the browser
    // paints, which keeps the browser-only app rendering its samples with no
    // visible "Loading documents…" frame. For the server source the continuation
    // lands a macrotask later, so this is effectively a no-op there and the
    // loading state still shows. One code path, both sources.
    flushSync(() => {
      this.setState({
        files,
        activeId: active.id,
        md: active.content,
        baseMtimeMs,
        loading: false,
        editingSide: 'init',
      })
    })
  }
```

- [ ] **Step 4: Add the save path and Cmd+S handler**

Add these members to the class:

```tsx
  private activeFile(): FileDoc | undefined {
    return this.state.files.find((f) => f.id === this.state.activeId)
  }

  onGlobalKey = (e: KeyboardEvent): void => {
    const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's'
    if (!isSave) return
    e.preventDefault()
    void this.saveActive()
  }

  saveActive = async (): Promise<void> => {
    // Never two writes in flight for one document. Both would carry the same
    // baseMtimeMs, so the first bumps the mtime and the second 409s against a
    // change the user themselves just made — producing a conflict banner whose
    // "theirContent" IS the user's own text. Cmd+S auto-repeat is enough to
    // trigger it, and once conflict resolution lands, taking that stale
    // "theirs" over a newer buffer is real data loss.
    if (this.saveInFlight) return

    const file = this.activeFile()
    // No file at all: still loading. Silent is right — there is nothing to say.
    if (file === undefined) return

    if (!this.props.source.canSave) {
      this.setState({ saveError: 'This document is not backed by a file on disk.' })
      return
    }

    // A document created in the editor (+ button, drag-and-drop) has no relPath,
    // so there is nowhere on disk to put it. Say so. Returning silently here
    // means Cmd+S does nothing at all — no write, no error, and no dirty flag,
    // since setMd cannot track an untracked document — and the user's text is
    // lost on reload with no indication it was ever at risk.
    if (file.relPath === undefined) {
      this.setState({
        saveError: `"${file.name}" is not backed by a file on disk. Use Export to save it.`,
      })
      return
    }

    const relPath = file.relPath
    this.setState({ saveError: null })
    const result = await this.props.source.save(
      relPath,
      this.state.md,
      this.state.baseMtimeMs[relPath] ?? null
    )
    if (result.ok) {
      this.setState((s) => ({
        dirty: { ...s.dirty, [relPath]: false },
        baseMtimeMs: { ...s.baseMtimeMs, [relPath]: result.mtimeMs },
        // A successful write settles any conflict on THIS document. Guarded by
        // relPath so an unresolved conflict on another document survives.
        conflict: s.conflict?.relPath === relPath ? null : s.conflict,
      }))
      return
    }
    if (result.reason === 'conflict') {
      this.setState({
        conflict: {
          relPath,
          theirContent: result.theirContent,
          theirMtimeMs: result.theirMtimeMs,
        },
      })
      return
    }
    this.setState({ saveError: result.message })
  }

  dismissSaveError = (): void => this.setState({ saveError: null })

  // Task 11 replaces these three with the real implementations. They are real
  // code, not stubs to remember: dismissing a conflict without resolving it is
  // the correct fallback behaviour until reload handling exists.
  onExternalChange = (event: SourceEvent): void => {
    // A change that lands while the stream is down produces no event, so
    // reconnecting must re-read rather than just clearing the indicator —
    // otherwise the UI goes back to claiming it is live while showing stale
    // content. Gated on having actually been disconnected: 'connected' also
    // fires on the very first connection, concurrently with loadFromSource,
    // whose flushSync replaces baseMtimeMs wholesale.

    if (event.type === 'connected') this.setState({ watching: true })
    if (event.type === 'disconnected') this.setState({ watching: false })
  }

  resolveKeepMine = (): void => this.setState({ conflict: null })

  resolveTakeTheirs = (): void => this.setState({ conflict: null })
```

- [ ] **Step 5: Mark documents dirty on edit — modify `setMd` at `src/App.tsx:75-81`**

```tsx
  setMd(md: string, side: Side): void {
    this.setState((s) => {
      const active = s.files.find((f) => f.id === s.activeId)
      const dirty =
        active?.relPath === undefined ? s.dirty : { ...s.dirty, [active.relPath]: true }
      return {
        md,
        editingSide: side,
        dirty,
        files: s.files.map((f) => (f.id === s.activeId ? { ...f, content: md } : f)),
      }
    })
  }
```

- [ ] **Step 5b: Stop the file-management UI making claims the save path cannot honour**

In disk-backed mode the sidebar's rename and delete act only on in-memory state, so
each one lies:

- **Rename** changes `name` but keeps `relPath`. The workspace is flat, so `name` and
  `relPath` are the same thing for every disk document — after a rename the sidebar
  shows `renamed.md` while Cmd+S writes `alpha.md`, and the conflict banner names a
  file that does not exist.
- **Delete** removes the row without touching disk, so the document reappears on
  reload. Worse, deleting the last one substitutes an `untitled.md` with no `relPath`
  — an unsaveable document.

Add one guard and use it to suppress both actions when the source is disk-backed:

```tsx
  /** True when file-management actions would only affect in-memory state. */
  private diskBacked(): boolean {
    return this.props.source.canSave
  }
```

In `renderFileRow`, render the rename (`✎`) and delete (`×`) buttons only when
`!this.diskBacked()`, and make `onDoubleClick={() => this.startRename(f.id)}` conditional
the same way. Leave `addFile` and drag-and-drop import in place — those create
in-editor documents, which `saveActive` now reports as unsaveable rather than dropping
silently.

> Renaming and deleting files on disk is a real feature, not a bug fix. It needs its
> own API endpoints and its own conflict story, so it is deliberately out of scope
> here; the guard exists so the UI cannot promise it.

- [ ] **Step 6: Render the banners and a loading state**

At the top of `render()`, before the existing markup, add a guard:

```tsx
if (this.state.loading) {
  return (
    <div className="grid min-h-screen place-items-center" style={{ color: 'var(--muted)' }}>
      Loading documents…
    </div>
  )
}
```

Then add the banners **inside** the outermost wrapper, as the first children of the
flex column — and change the inner full-height div from `h-screen` to `flex-1 min-h-0`.

The banners are siblings above a `h-screen` child inside a `height: 100%` root, and
`index.css` sets no `overflow: hidden`, so showing one makes the total content
`banner + 100vh`: the body gains a scrollbar and the app's own footer is clipped —
exactly when the user most needs the full UI to resolve a conflict.

```tsx
{
  this.state.conflict !== null && (
    <ConflictBanner
      fileName={this.state.conflict.relPath}
      onKeepMine={this.resolveKeepMine}
      onTakeTheirs={this.resolveTakeTheirs}
    />
  )
}
{
  this.state.saveError !== null && (
    <SaveErrorBanner message={this.state.saveError} onDismiss={this.dismissSaveError} />
  )
}
{
  this.props.source.canSave && !this.state.watching && (
    <div
      role="status"
      className="border-b px-4 py-1 text-[12px]"
      style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}
    >
      Not watching for changes — reconnecting…
    </div>
  )
}
```

Add the imports at the top of `App.tsx`:

```tsx
import type { SourceEvent } from './lib/docSource'
import { flushSync } from 'react-dom'
import { ConflictBanner, SaveErrorBanner } from './ui/ConflictBanner'
```

- [ ] **Step 7: Wire the source in at boot — replace `src/main.tsx` entirely**

```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { detectSource } from './lib/detectSource'

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found')

const source = detectSource(window.location.origin, window.location.search)

// Keep the token out of the address bar, history, and any copy-pasted URL.
if (new URLSearchParams(window.location.search).has('t')) {
  window.history.replaceState({}, '', window.location.pathname)
}

createRoot(container).render(
  <React.StrictMode>
    <App source={source} />
  </React.StrictMode>
)
```

- [ ] **Step 8: Verify typecheck, lint, and the full suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass. If `typecheck` complains that `source` is missing on `Props`,
re-check Step 1 — `source` must be required, not optional, and `defaultProps` must
not list it.

- [ ] **Step 9: Confirm the browser-only build still works**

Run: `pnpm build && pnpm preview`, open the printed URL with no query string.
Expected: the three sample documents load exactly as before, and Cmd+S surfaces
"not backed by a file on disk" rather than doing nothing.

- [ ] **Step 10: Commit**

```bash
git add src/App.tsx src/types.ts src/ui/ConflictBanner.tsx src/main.tsx
git commit -m "feat(app): load documents from a source, track dirty state, save with Cmd+S"
```

---

### Task 11: External change handling and conflict resolution

**Files:**

- Modify: `src/App.tsx`

**Interfaces:**

- Consumes: `ChangeEvent` from `./lib/docSource`.
- Produces: `onExternalChange`, `resolveKeepMine`, `resolveTakeTheirs` (replacing the Task 10 stubs).

- [ ] **Step 0: Close the last silent-loss path — a save must not clear dirty state it did not write**

Task 10's review found this, out of its own scope, and it is the highest-value item in
this task. Interleaving:

1. Type `A` → `dirty[alpha] = true`.
2. Cmd+S → `PUT` with content `A` goes in flight.
3. Type `B` before it resolves → buffer is now `AB`. A rescuing Cmd+S is **dropped** by
   the in-flight guard.
4. The `PUT` resolves ok → the success branch clears `dirty[alpha]`.

Buffer is `AB`, disk is `A`, and `onBeforeUnload` now early-returns because nothing looks
dirty — so the tab closes with no prompt and `B` is gone. The window is one local
round-trip, so this is occasional rather than routine, but it sits directly underneath
the unload safety net and is invisible when it happens.

Capture what was sent and only clear the flag if the buffer still matches it:

```tsx
const relPath = file.relPath
const sent = this.state.md
this.setState({ saveError: null })
const result = await this.props.source.save(relPath, sent, this.state.baseMtimeMs[relPath] ?? null)
if (result.ok) {
  this.setState((s) => ({
    // Only this exact content reached disk. If the buffer moved on while the
    // write was in flight, those newer edits are still unsaved — clearing the
    // flag here would strand them with no dirty marker and no unload prompt.
    dirty: s.md === sent ? { ...s.dirty, [relPath]: false } : s.dirty,
    baseMtimeMs: { ...s.baseMtimeMs, [relPath]: result.mtimeMs },
    conflict: s.conflict?.relPath === relPath ? null : s.conflict,
  }))
  return
}
```

> Comparing `s.md` is correct only because the guard permits one write at a time per
> app, so `sent` cannot belong to a different document than the one now active.

Also make the in-flight guard an instance field rather than React state, so it does not
depend on React having flushed `saving: true` before the next input task:

```tsx
  private saveInFlight = false
```

Set it `true` immediately before the `await` and `false` in a `finally`, and have
`saveActive` return early on it instead of on `this.state.saving`. Do **not** keep
`state.saving` — Step 0d removes it, since nothing reads it.

- [ ] **Step 0b: A dropped file in disk mode must not become permanently stuck**

Task 10 hid rename and delete whenever the source is disk-backed, but keyed that on the
_source_ rather than the _row_. Drag-and-drop still creates in-editor documents, so a
stray drop in disk mode produces a row that is unsaveable **and** unremovable for the
rest of the session. Delete on such a row is truthful — it only ever touched in-memory
state. In `renderFileRow`, widen the guard:

```tsx
const canManage = !this.diskBacked() || f.relPath === undefined
```

- [ ] **Step 0d: Drop the dead `saving` state**

`state.saving` is written in five places and read in none — two consecutive reviews
flagged the 4-writes/0-reads pattern, and Step 0 moved the actual guard to the
`saveInFlight` instance field. An earlier note said to keep it "for the UI", but no UI
consumes it and nothing lints dead state. Remove the field from `State`, its constructor
seed, and every `saving:` write. Use `saveInFlight` for the guard and set it inside the
`try`, cleared in `finally`, so a throw cannot wedge saves for the session.

- [ ] **Step 0c: Extract the two data-loss decisions into pure, tested helpers**

`resolveTakeTheirs`'s `null` branch is the one place in this codebase whose regression is
silent, unrecoverable data loss — someone "simplifying" it to `theirContent ?? ''` would
overwrite a user's document with nothing, and today the only thing preventing that is a
comment. Same for the echo check: written as a bare mtime comparison inside a component
method, it is easy to invert. Neither is testable where it sits, because the `app` Vitest
project only includes `src/**/*.test.ts` and there is no React testing library.

Both decisions are pure functions of their inputs. Move them out.

Create `src/lib/conflictResolution.ts`:

```ts
/** What "take theirs" should do with a conflict. */
export type TakeTheirsOutcome = { kind: 'gone' } | { kind: 'apply'; content: string }

/**
 * A null `theirContent` means the document vanished from disk — there is no
 * "theirs" to take. Returning 'gone' rather than an empty string is the whole
 * point: applying '' would replace the user's text with nothing, which is data
 * loss dressed up as conflict resolution.
 */
export function decideTakeTheirs(theirContent: string | null): TakeTheirsOutcome {
  if (theirContent === null) return { kind: 'gone' }
  return { kind: 'apply', content: theirContent }
}

/**
 * True when a change notification describes our own write. The CLI watches the
 * workspace and notifies on any change, including the one this app just made,
 * so a save bounces an event straight back. If disk still carries the mtime we
 * loaded or last wrote, nothing moved and there is nothing to reload.
 */
export function isOwnEcho(
  diskMtimeMs: number | null,
  baseMtimeMs: number | null | undefined
): boolean {
  if (diskMtimeMs === null || baseMtimeMs === null || baseMtimeMs === undefined) return false
  return diskMtimeMs === baseMtimeMs
}
```

Create `src/lib/conflictResolution.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { decideTakeTheirs, isOwnEcho } from './conflictResolution'

describe('decideTakeTheirs', () => {
  it('applies the on-disk content when there is some', () => {
    expect(decideTakeTheirs('# theirs')).toEqual({ kind: 'apply', content: '# theirs' })
  })

  it('applies genuinely empty on-disk content', () => {
    // A file truncated to nothing is a real state and must be applicable —
    // this is why the "no theirs" signal is null and not ''.
    expect(decideTakeTheirs('')).toEqual({ kind: 'apply', content: '' })
  })

  it('reports gone for a vanished document rather than inventing content', () => {
    // The regression this exists to catch: `theirContent ?? ''` would return
    // { kind: 'apply', content: '' } here and silently wipe the user's buffer.
    expect(decideTakeTheirs(null)).toEqual({ kind: 'gone' })
  })
})

describe('isOwnEcho', () => {
  it('recognises an unchanged mtime as our own write', () => {
    expect(isOwnEcho(1000, 1000)).toBe(true)
  })

  it('treats a moved mtime as a genuine external change', () => {
    expect(isOwnEcho(2000, 1000)).toBe(false)
  })

  it('treats a never-saved document as a genuine change', () => {
    // baseMtimeMs null means "should be a new file"; any disk content is news.
    expect(isOwnEcho(1000, null)).toBe(false)
    expect(isOwnEcho(1000, undefined)).toBe(false)
  })

  it('treats an unknown disk mtime as a genuine change', () => {
    // Fail toward reloading: a missed echo costs a redundant read, a missed
    // real change shows the user stale content.
    expect(isOwnEcho(null, 1000)).toBe(false)
  })
})
```

Then use them in `App.tsx`: replace the inline echo comparison with
`if (isOwnEcho(doc.mtimeMs, this.state.baseMtimeMs[relPath])) return`, and branch
`resolveTakeTheirs` on `decideTakeTheirs(conflict.theirContent)` instead of testing
`=== null` inline. Import from `./lib/conflictResolution`.

`src/lib/conflictResolution.test.ts` adds **7 tests** (117 → 124).

- [ ] **Step 1: Implement the change handler**

Replace the two stubs with:

```tsx
  onExternalChange = (event: SourceEvent): void => {
    if (event.type === 'connected') {
      const wasDisconnected = this.state.watching === false && this.state.loading === false
      this.setState({ watching: true })
      if (wasDisconnected) {
        for (const file of this.state.files) {
          if (file.relPath !== undefined) void this.reloadFromDisk(file.relPath)
        }
      }
      return
    }
    if (event.type === 'disconnected') {
      this.setState({ watching: false })
      return
    }
    if (event.type === 'removed') {
      this.setState((s) => ({
        baseMtimeMs: { ...s.baseMtimeMs, [event.relPath]: null },
        // Mark it dirty: the buffer is now the ONLY copy. Without this there is
        // no bullet and no unload prompt, so the last remaining copy of a file
        // someone just deleted can be closed away silently. Matches what the
        // null branch of resolveTakeTheirs already does for the same situation.
        dirty: { ...s.dirty, [event.relPath]: true },
        saveError: `${event.relPath} was deleted on disk. Saving will recreate it.`,
      }))
      return
    }
    void this.reloadFromDisk(event.relPath)
  }

  /**
   * Refresh a document from disk. Clean documents update silently; dirty ones
   * raise a conflict so local edits are never discarded.
   */
  private async reloadFromDisk(relPath: string): Promise<void> {
    const doc = await this.props.source.read(relPath).catch(() => null)
    if (doc === null) return

    // Ignore the echo of our own write. The CLI watches the workspace and
    // notifies on ANY change, including the one this app just made, so every
    // successful save bounces a `changed` event straight back. Without this
    // check, typing inside the watcher's debounce window of your own save
    // raises a banner claiming the file "changed on disk" when nothing did —
    // and offers a one-click "Take theirs" that discards those keystrokes.
    //
    // Same oracle the server uses for its own conflict check: if the mtime
    // still matches what we loaded or last wrote, disk has not moved, so there
    // is nothing to reload and nothing to conflict over.
    if (doc.mtimeMs !== null && doc.mtimeMs === this.state.baseMtimeMs[relPath]) return

    if (this.state.dirty[relPath] === true) {
      this.setState({
        conflict: { relPath, theirContent: doc.content, theirMtimeMs: doc.mtimeMs },
      })
      return
    }

    this.setState((s) => {
      const files = s.files.map((f) => (f.relPath === relPath ? { ...f, content: doc.content } : f))
      const active = files.find((f) => f.id === s.activeId)
      const isActive = active?.relPath === relPath
      return {
        files,
        md: isActive ? doc.content : s.md,
        editingSide: isActive ? 'init' : s.editingSide,
        baseMtimeMs: { ...s.baseMtimeMs, [relPath]: doc.mtimeMs },
      }
    })
  }

  /** Keep the in-editor version; adopt their mtime so the next save succeeds. */
  resolveKeepMine = (): void => {
    const conflict = this.state.conflict
    if (conflict === null) return
    this.setState((s) => ({
      conflict: null,
      baseMtimeMs: { ...s.baseMtimeMs, [conflict.relPath]: conflict.theirMtimeMs },
    }))
  }

  /** Discard local edits for this document and take the on-disk version. */
  resolveTakeTheirs = (): void => {
    const conflict = this.state.conflict
    if (conflict === null) return

    // No on-disk version to take: the document was deleted. Taking "theirs"
    // here would replace the user's text with nothing, which is data loss
    // dressed up as conflict resolution. Keep the buffer and say so.
    if (conflict.theirContent === null) {
      this.setState((s) => ({
        conflict: null,
        baseMtimeMs: { ...s.baseMtimeMs, [conflict.relPath]: null },
        saveError: `${conflict.relPath} no longer exists on disk. Saving will recreate it.`,
      }))
      return
    }
    const theirContent = conflict.theirContent

    this.setState((s) => {
      const files = s.files.map((f) =>
        f.relPath === conflict.relPath ? { ...f, content: theirContent } : f
      )
      const active = files.find((f) => f.id === s.activeId)
      const isActive = active?.relPath === conflict.relPath
      return {
        conflict: null,
        files,
        md: isActive ? theirContent : s.md,
        editingSide: isActive ? 'init' : s.editingSide,
        dirty: { ...s.dirty, [conflict.relPath]: false },
        baseMtimeMs: { ...s.baseMtimeMs, [conflict.relPath]: conflict.theirMtimeMs },
      }
    })
  }
```

The `SourceEvent` type import added in Task 10 already covers this.

- [ ] **Step 2: Show a dirty marker in both file-row variants**

`renderFileRow` renders the filename twice — once for the sidebar list variant and
once for the tab variant. Both need the marker.

At `src/App.tsx:371-373` (list variant), change:

```tsx
<span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
  {f.name}
  {this.isDirty(f) ? ' •' : ''}
</span>
```

At `src/App.tsx:421-423` (tab variant), change:

```tsx
<span className="overflow-hidden text-ellipsis whitespace-nowrap max-w-[160px]">
  {f.name}
  {this.isDirty(f) ? ' •' : ''}
</span>
```

Add the helper alongside `activeFile()`:

```tsx
  private isDirty(f: FileDoc): boolean {
    // Only meaningful when a save can actually clear it. LocalDocSource's samples
    // carry relPath values, so without this gate every edited sample keeps a
    // permanent bullet that nothing in the browser-only app can ever remove.
    if (!this.diskBacked()) return false
    return f.relPath !== undefined && this.state.dirty[f.relPath] === true
  }
```

- [ ] **Step 3: Verify typecheck, lint, and the suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): auto-reload clean documents and resolve conflicts when dirty"
```

---

### Task 12: End-to-end smoke test

Proves the one thing no unit test covers: CLI → browser → Cmd+S → bytes on disk.

**Files:**

- Create: `playwright.config.ts`, `e2e/cli-bridge.spec.ts`
- Modify: `package.json`, `.gitignore`

**Interfaces:**

- Consumes: the built CLI at `dist-cli/index.js` and the built app at `dist/`.
- Produces: `pnpm test:e2e`.

- [ ] **Step 1: Install Playwright**

```bash
pnpm add -D @playwright/test
pnpm exec playwright install chromium
```

- [ ] **Step 1b: Bring `e2e/` under typecheck**

No tsconfig project includes `e2e/` or `playwright.config.ts`, so a blatant type error in
either passes `pnpm typecheck` and `pnpm lint` with exit 0 — verified empirically. This is
the same gap this plan already closed for `cli/**/*.test.ts` with `tsconfig.cli-test.json`;
reuse that pattern rather than inventing a new one. An E2E spec that is never typechecked
is precisely where a silent breakage hides.

Create `tsconfig.e2e.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "skipLibCheck": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noEmit": true
  },
  "include": ["e2e/**/*.ts", "playwright.config.ts"]
}
```

Add the reference to `tsconfig.json`:

```json
{ "path": "./tsconfig.e2e.json" }
```

Prove it works the same way Task 1's equivalent was proved: put
`const bad: number = 'x'` in the spec, confirm `pnpm typecheck` now **fails**, remove it,
confirm it passes again. A config that compiles but still misses the files looks identical
to a working one without that check.

- [ ] **Step 2: Create `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: { headless: true },
})
```

Append to `.gitignore`:

```
test-results/
playwright-report/
```

- [ ] **Step 3: Write the failing test**

Create `e2e/cli-bridge.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let cli: ChildProcessWithoutNullStreams | null = null
let workdir = ''

/** Start the CLI on a temp workspace and return the tokenised URL it prints. */
async function startCli(): Promise<string> {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'bmd-e2e-'))
  await fs.writeFile(path.join(workdir, 'hello.md'), '# hello\n', 'utf8')

  cli = spawn('node', ['dist-cli/index.js', '--no-open', workdir], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CLI did not print a URL in time')), 15_000)
    let buffered = ''
    cli!.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const match = /(http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+)/.exec(buffered)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    cli!.stderr.on('data', (chunk: Buffer) => {
      clearTimeout(timer)
      reject(new Error(`CLI failed: ${chunk.toString('utf8')}`))
    })
  })
}

test.afterEach(async () => {
  cli?.kill('SIGTERM')
  cli = null
  if (workdir !== '') {
    await fs.rm(workdir, { recursive: true, force: true })
    workdir = ''
  }
})

test('edits made in the browser save back to the file on disk', async ({ page }) => {
  const url = await startCli()
  await page.goto(url)

  const editor = page.locator('textarea')
  await expect(editor).toHaveValue(/# hello/)

  await editor.fill('# hello from playwright\n')

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')

  await expect
    .poll(async () => fs.readFile(path.join(workdir, 'hello.md'), 'utf8'), { timeout: 10_000 })
    .toContain('hello from playwright')
})

test('the token is stripped from the address bar after boot', async ({ page }) => {
  const url = await startCli()
  await page.goto(url)
  await expect(page.locator('textarea')).toBeVisible()
  expect(page.url()).not.toContain('t=')
})

test('loading without a token falls back to sample documents', async ({ page }) => {
  const url = await startCli()
  await page.goto(new URL(url).origin)
  await expect(page.locator('textarea')).toBeVisible()

  const before = await fs.readFile(path.join(workdir, 'hello.md'), 'utf8')
  await page.locator('textarea').fill('should not reach disk')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')

  // Wait on the app's actual response, not a sleep. The save-error banner is
  // observable proof that Cmd+S was handled and refused; a fixed timeout would
  // silently start passing for the wrong reason if this path ever became async,
  // reading the file before a delayed write landed.
  await expect(page.getByRole('alert')).toContainText('not backed by a file on disk')

  expect(await fs.readFile(path.join(workdir, 'hello.md'), 'utf8')).toBe(before)
})
```

- [ ] **Step 4: Run it to verify it fails for the right reason**

Run: `pnpm build && pnpm build:cli && pnpm test:e2e`
Expected: if any test fails, the failure must be a real assertion or wiring
problem — not a missing build. Re-run the build first if the CLI reports a
missing bundle.

- [ ] **Step 5: Fix whatever the E2E surfaces, then confirm green**

Run: `pnpm test:e2e`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts e2e package.json pnpm-lock.yaml .gitignore
git commit -m "test(e2e): verify the CLI bridge saves browser edits to disk"
```

---

### Task 13: Documentation and full verification

**Files:**

- Modify: `README.md`, `docs/superpowers/specs/2026-08-03-cli-bridge-design.md`

- [ ] **Step 1: Document the security model in `README.md`**

Extend the existing "Security note" section:

```markdown
### CLI security model

The CLI runs a short-lived HTTP server on `127.0.0.1` at an ephemeral port. Because
any page in your browser can reach a localhost port, three independent layers guard
the file API:

1. **Bearer token** — a fresh 32-byte token per run, required on every `/api/*`
   request. It arrives via the launch URL and is stripped from the address bar
   immediately. Custom headers cannot be forged by cross-site form or image requests.
2. **Origin validation** — requests carrying a foreign `Origin` are refused.
3. **Path confinement** — only bare filenames with a `.md`, `.markdown`, or `.txt`
   extension resolving inside the workspace root are readable or writable, symlinks
   included.

Saves are guarded by an mtime check: if the file changed on disk since it was loaded,
the write is refused and you choose which version wins.
```

- [ ] **Step 2: Mark the spec's pre-publish checklist as done**

In the spec's "Open-sourcing" section, note that items 1-4 were completed on
2026-08-03 (`.agents/skills/` untracked and purged from history, MIT LICENSE added,
README link fixed, commit authorship rewritten), and that the repo remains private
pending this feature.

- [ ] **Step 2b: Add the same-length wrong-token test carried over from Task 6's review**

`cli/server.test.ts`'s existing wrong-token case uses `'not-the-token'`, which differs in
length from the real token and therefore short-circuits at `timingSafeEqualStr`'s length
check — `crypto.timingSafeEqual` itself was never reached by any test. Add the
`rejects a same-length wrong token with 401` case from Task 5's Step 1 block (it reverses
the real token, so the length matches and the value does not). `cli/server.test.ts` goes
to 24 tests.

- [ ] **Step 2c: Pin `isOwnEcho`'s null guards**

Task 11's re-review ran the shipped 7 tests against a copy of `isOwnEcho` with **both**
null guards deleted (`return diskMtimeMs === baseMtimeMs`) and got 7/7 passing. The only
input pair the guards actually decide is `(null, null)`, and nothing covers it — so the
helper extracted specifically for mutation resistance is only half-protected.

Add to `src/lib/conflictResolution.test.ts`:

```ts
it('treats a null-mtime document with no baseline as a genuine change', () => {
  // Without the null guards this returns true (null === null) and the reload is
  // suppressed. Nothing else in the suite distinguishes that mutation.
  expect(isOwnEcho(null, null)).toBe(false)
})
```

`src/lib/conflictResolution.test.ts` goes to **8 tests** (124 → 125). Prove it is
load-bearing: delete both null guards, confirm this test alone fails, restore.

- [ ] **Step 3: Run every check**

Run:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm build:cli && pnpm test:e2e
```

Expected: all green. Record the actual test counts in the commit message.

- [ ] **Step 4: Manual acceptance against real plans**

```bash
node dist-cli/index.js --plan
```

Verify: the sidebar lists your plans, the newest is active, editing marks it dirty,
Cmd+S writes to `~/.claude/plans/`, and asking Claude to revise a plan while the page
is clean refreshes the view automatically.

> This touches real files in `~/.claude/plans`. Copy one to a scratch directory and
> test there first if you would rather not edit a real plan.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-08-03-cli-bridge-design.md
git commit -m "docs: document the CLI bridge and its security model"
```

---

## Post-plan: publishing

Only after Task 13 passes is the repo ready to go public, per the spec's ordering
constraint. Publishing is a separate, explicit decision:

```bash
gh repo edit Sachchaa/better-md --visibility public
```

Before running it, confirm: `git log --format='%ae' | sort -u` shows only the intended
address, and `git log --all --name-only | grep -c '\.agents/skills'` returns 0.
