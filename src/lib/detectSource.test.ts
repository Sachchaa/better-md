import { describe, expect, it } from 'vitest'
import { detectSource } from './detectSource'
import { LocalDocSource } from './docSource'
import { ServerDocSource } from './serverDocSource'

describe('detectSource', () => {
  it('returns a saving source when a token is present', () => {
    const source = detectSource('http://127.0.0.1:5173', '?t=abc123')
    expect(source.canSave).toBe(true)
    expect(source).toBeInstanceOf(ServerDocSource)
  })

  it('returns the local source when no token is present', () => {
    const source = detectSource('http://127.0.0.1:5173', '')
    expect(source.canSave).toBe(false)
    expect(source).toBeInstanceOf(LocalDocSource)
  })

  it('ignores an empty token', () => {
    const source = detectSource('http://127.0.0.1:5173', '?t=')
    expect(source.canSave).toBe(false)
    expect(source).toBeInstanceOf(LocalDocSource)
  })

  it('ignores unrelated query parameters', () => {
    const source = detectSource('http://127.0.0.1:5173', '?theme=dark')
    expect(source.canSave).toBe(false)
    expect(source).toBeInstanceOf(LocalDocSource)
  })
})
