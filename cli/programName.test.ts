import { describe, expect, it } from 'vitest'
import { CANONICAL_NAME, programName } from './programName.js'

describe('programName', () => {
  it('echoes the shim the user actually invoked', () => {
    expect(programName('/usr/local/bin/btr-md')).toBe('btr-md')
    expect(programName('/usr/local/bin/better-md')).toBe('better-md')
  })

  it('strips a .js extension from a shim name', () => {
    // pnpm/npm shims on some platforms keep the extension.
    expect(programName('/somewhere/node_modules/.bin/better-md.js')).toBe('better-md')
  })

  it('falls back to the canonical name for a direct node invocation', () => {
    // argv[1] is the entry file here, which says nothing about intent — without
    // this the CLI would introduce itself as "index".
    expect(programName('/repo/dist-cli/index.js')).toBe(CANONICAL_NAME)
  })

  it('falls back for an unrecognised name rather than trusting argv', () => {
    // argv[1] is attacker-influencable in odd setups; only known shims are echoed.
    expect(programName('/tmp/rm -rf /')).toBe(CANONICAL_NAME)
    expect(programName(undefined)).toBe(CANONICAL_NAME)
    expect(programName('')).toBe(CANONICAL_NAME)
  })
})
