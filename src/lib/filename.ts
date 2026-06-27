/** Normalize a user-entered file name and ensure it's unique.
 *
 * - Trims; returns null for an empty name (caller should cancel the rename).
 * - Appends `.md` when no known markdown/text extension is present.
 * - De-duplicates against `taken` (case-insensitive) by adding a `-N` suffix
 *   before the extension.
 */
export function resolveFileName(raw: string, taken: string[]): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  let name = /\.(md|markdown|txt)$/i.test(trimmed) ? trimmed : trimmed + '.md'

  const has = (candidate: string): boolean =>
    taken.some((t) => t.toLowerCase() === candidate.toLowerCase())

  if (has(name)) {
    const dot = name.lastIndexOf('.')
    const base = name.slice(0, dot)
    const ext = name.slice(dot)
    let n = 2
    while (has(`${base}-${n}${ext}`)) n++
    name = `${base}-${n}${ext}`
  }
  return name
}
