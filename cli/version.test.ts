import { describe, expect, it } from 'vitest'
import { assetName, isNewer, parseVersion } from './version.js'

describe('parseVersion', () => {
  it('accepts a release tag with or without the v prefix', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null })
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null })
  })

  it('captures a prerelease and ignores build metadata', () => {
    expect(parseVersion('1.0.0-rc.1')?.prerelease).toBe('rc.1')
    expect(parseVersion('1.0.0+build.5')?.prerelease).toBeNull()
  })

  it('rejects anything that is not a version', () => {
    for (const bad of ['', 'latest', '1.2', 'v1.2.3.4', 'not-a-version', '1.2.x']) {
      expect(parseVersion(bad), bad).toBeNull()
    }
  })
})

describe('isNewer', () => {
  it.each([
    ['0.2.0', '0.1.0'],
    ['1.0.0', '0.9.9'],
    ['0.1.10', '0.1.9'],
    ['v0.2.0', '0.1.0'],
  ])('%s is newer than %s', (candidate, current) => {
    expect(isNewer(candidate, current)).toBe(true)
  })

  it.each([
    ['0.1.0', '0.1.0'],
    ['0.1.0', '0.2.0'],
    ['0.9.9', '1.0.0'],
    // 0.1.9 vs 0.1.10 is the case a string comparison gets backwards.
    ['0.1.9', '0.1.10'],
  ])('%s is not newer than %s', (candidate, current) => {
    expect(isNewer(candidate, current)).toBe(false)
  })

  it('sorts a prerelease before its final release', () => {
    expect(isNewer('1.0.0', '1.0.0-rc.1')).toBe(true)
    expect(isNewer('1.0.0-rc.1', '1.0.0')).toBe(false)
  })

  it('never reports an update when either version is unparseable', () => {
    // The consequence of getting this wrong is telling someone to upgrade to a
    // version that does not exist, so an unreadable tag must mean "no update".
    expect(isNewer('garbage', '0.1.0')).toBe(false)
    expect(isNewer('9.9.9', 'garbage')).toBe(false)
  })
})

describe('assetName', () => {
  it('matches what install.sh downloads', () => {
    expect(assetName('darwin', 'arm64')).toBe('better-md-darwin-arm64')
    expect(assetName('darwin', 'x64')).toBe('better-md-darwin-x64')
    expect(assetName('linux', 'arm64')).toBe('better-md-linux-arm64')
    expect(assetName('linux', 'x64')).toBe('better-md-linux-x64')
  })

  it('is null where no build is published', () => {
    expect(assetName('win32', 'x64')).toBeNull()
    expect(assetName('linux', 'riscv64')).toBeNull()
  })

  // The alias is a copy of the same asset, so it must not ask for a btr-md build
  // that no release publishes.
  it('always asks for the better-md asset, never the alias', () => {
    expect(assetName('linux', 'x64')).not.toContain('btr-md')
  })
})
