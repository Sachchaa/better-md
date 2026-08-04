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
