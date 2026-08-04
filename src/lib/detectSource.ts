import { LocalDocSource, type DocSource } from './docSource'
import { ServerDocSource } from './serverDocSource'

/**
 * Choose a document source from the boot URL. A token means the page was opened
 * by the CLI; without one the app behaves exactly as the browser-only build.
 */
export function detectSource(origin: string, search: string): DocSource {
  const token = new URLSearchParams(search).get('t')
  if (token === null || token === '') return new LocalDocSource()
  return new ServerDocSource(origin, token)
}
