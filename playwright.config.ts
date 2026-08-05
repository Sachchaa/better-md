import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: { headless: true },
  // Serve dist/ over HTTP so the site tests exercise real URL resolution. They
  // used to load dist/site/index.html over file://, where a relative image src
  // resolves to a sibling file and passes — while in production the page is
  // rewritten to `/` and that same src resolves to the root, 404ing. Only an
  // origin with paths can catch that class of bug.
  webServer: {
    command: 'node scripts/preview-routed.mjs --port 4173',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
