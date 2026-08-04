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
    // Every sample is always readable; ServerDocSource is the one that can
    // drop entries here.
    expect(listing.unreadable).toEqual([])
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
