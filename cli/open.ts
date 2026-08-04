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
