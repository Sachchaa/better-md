import { describe, it, expect } from 'vitest'
import { resolveFileName } from './filename'

describe('resolveFileName', () => {
  it('trims and returns null for empty input', () => {
    expect(resolveFileName('', [])).toBeNull()
    expect(resolveFileName('   ', [])).toBeNull()
  })

  it('appends .md when no known extension is given', () => {
    expect(resolveFileName('notes', [])).toBe('notes.md')
    expect(resolveFileName('  draft ', [])).toBe('draft.md')
  })

  it('keeps recognised extensions as-is', () => {
    expect(resolveFileName('a.md', [])).toBe('a.md')
    expect(resolveFileName('a.markdown', [])).toBe('a.markdown')
    expect(resolveFileName('a.txt', [])).toBe('a.txt')
  })

  it('treats unknown extensions as part of the base name', () => {
    expect(resolveFileName('archive.zip', [])).toBe('archive.zip.md')
  })

  it('de-duplicates case-insensitively with a -N suffix', () => {
    expect(resolveFileName('notes.md', ['notes.md'])).toBe('notes-2.md')
    expect(resolveFileName('NOTES.md', ['notes.md'])).toBe('NOTES-2.md')
    expect(resolveFileName('notes', ['notes.md', 'notes-2.md'])).toBe('notes-3.md')
  })

  it('does not collide with the name being edited (caller excludes self)', () => {
    expect(resolveFileName('readme.md', [])).toBe('readme.md')
  })
})
