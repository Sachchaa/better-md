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
