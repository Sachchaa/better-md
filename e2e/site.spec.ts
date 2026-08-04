import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The marketing site at better-md.dev.
 *
 * Runs against `dist/site/index.html` rather than the source in `public/`, so it
 * also proves the build actually publishes the page — moving it out of `public/`
 * would drop it from `dist/` and fail here rather than 404ing in production.
 *
 * The page is self-contained (inline CSS, no bundle), so a file:// URL exercises
 * everything except the webfont.
 */
const PAGE = pathToFileURL(path.resolve('dist/site/index.html')).href

/**
 * Where the hosted editor lives. Hardcoded on purpose: the point of these tests
 * is to catch a typo'd or half-renamed host, so reading the value out of the page
 * would assert the page agrees with itself.
 */
const PLAYGROUND = 'https://playground.better-md.dev'

test('explains what better-md is', async ({ page }) => {
  await page.goto(PAGE)

  await expect(page.locator('h1')).toHaveText(/Markdown files/)
  await expect(page.locator('#how')).toContainText('local server')
})

test('publishes the install command that actually exists', async ({ page }) => {
  await page.goto(PAGE)

  const shown = (await page.locator('#install-cmd').innerText()).trim()
  expect(shown).toBe('curl -fsSL https://better-md.dev/install.sh | sh')

  // The URL in that command is a real published artifact, so assert the two agree
  // rather than trusting the string: install.sh is copied into dist/ by the build,
  // and a page advertising a path the deploy does not serve is the failure here.
  await expect(fs.access(path.resolve('dist/install.sh'))).resolves.toBeUndefined()
})

// Four separate links offer the playground: the nav, the hero button, the prose in
// the install section, and the footer. Enumerated by id rather than matched by a
// selector, so renaming the subdomain and updating only some of them fails here —
// a half-rename leaves a dead button that nothing else in the suite would catch.
const PLAYGROUND_LINKS = ['nav-playground', 'cta-playground', 'body-playground', 'foot-playground']

test('every playground link points at the same live host', async ({ page }) => {
  await page.goto(PAGE)

  for (const id of PLAYGROUND_LINKS) {
    const href = await page.locator(`#${id}`).getAttribute('href')
    expect(href, `#${id} points somewhere unexpected`).toBe(PLAYGROUND)
  }
})

test('the copy button reports success without a clipboard permission', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-write'])
  await page.goto(PAGE)

  await page.locator('#copy').click()

  // Confirms the handler runs and gives feedback. The catch branch matters as much
  // as the success one — on a file:// or http:// origin navigator.clipboard is
  // undefined, and the button must still say something rather than throwing.
  await expect(page.locator('#copy')).toHaveText(/Copied|Select it/)
})
