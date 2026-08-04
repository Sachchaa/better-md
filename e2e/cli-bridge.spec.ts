import { expect, test } from '@playwright/test'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'

// spawn(..., { stdio: ['ignore', 'pipe', 'pipe'] }) has no stdin stream (it's
// null), so ChildProcessWithoutNullStreams — which requires a writable stdin
// too — does not describe the value spawn() actually returns here.
let cli: ChildProcessByStdio<null, Readable, Readable> | null = null
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
