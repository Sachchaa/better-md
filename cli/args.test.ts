import { describe, expect, it } from 'vitest'
import { InfoRequest, parseCliArgs, usage, UsageError } from './args.js'

describe('parseCliArgs', () => {
  it('accepts a single file target', () => {
    expect(parseCliArgs(['notes.md'])).toEqual({
      target: 'notes.md',
      plan: false,
      port: null,
      open: true,
      agent: null,
      detach: false,
      terminal: false,
      command: null,
      initTarget: null,
      write: false,
      checkUpdates: false,
    })
  })

  it('accepts --plan with no positional', () => {
    expect(parseCliArgs(['--plan'])).toEqual({
      target: null,
      plan: true,
      port: null,
      open: true,
      agent: null,
      detach: false,
      terminal: false,
      command: null,
      initTarget: null,
      write: false,
      checkUpdates: false,
    })
  })

  it('rejects --plan combined with a positional target', () => {
    expect(() => parseCliArgs(['--plan', 'notes.md'])).toThrow(UsageError)
  })

  // Superseded: a bare invocation used to be an error, and now shows help. The
  // two cases below the command list cover both halves of the replacement rule.
  it('rejects a target-less run that was clearly meant to open something', () => {
    expect(() => parseCliArgs(['--no-open'])).toThrow(UsageError)
  })

  it('rejects more than one positional', () => {
    expect(() => parseCliArgs(['a.md', 'b.md'])).toThrow(UsageError)
  })

  it('parses --port', () => {
    expect(parseCliArgs(['--port', '4321', 'a.md']).port).toBe(4321)
  })

  // null and 0 must stay distinguishable: null means "apply the default policy"
  // (prefer 8080, fall back), while an explicit 0 is a request for an ephemeral
  // port and is honoured literally. Collapsing them would make `--port 0` behave
  // like omitting the flag.
  it('distinguishes an absent --port from an explicit 0', () => {
    expect(parseCliArgs(['a.md']).port).toBeNull()
    expect(parseCliArgs(['--port', '0', 'a.md']).port).toBe(0)
  })

  it('rejects a non-numeric port', () => {
    expect(() => parseCliArgs(['--port', 'abc', 'a.md'])).toThrow(UsageError)
  })

  it('rejects an out-of-range port', () => {
    expect(() => parseCliArgs(['--port', '99999', 'a.md'])).toThrow(UsageError)
  })

  it('honours --no-open', () => {
    expect(parseCliArgs(['--no-open', 'a.md']).open).toBe(false)
  })

  // InfoRequest, not UsageError: --help is a request for output, so index.ts
  // prints it to stdout and exits 0. It used to be a UsageError, which meant
  // stderr and exit 1 — `better-md --help | less` showed nothing.
  it('reports --help via InfoRequest carrying the usage text', () => {
    expect(() => parseCliArgs(['--help'])).toThrow(InfoRequest)
    try {
      parseCliArgs(['--help'])
    } catch (err) {
      expect((err as Error).message).toContain('Usage:')
      expect((err as Error).message).toContain('--version')
    }
  })

  it('reports --version via InfoRequest naming the program and a version', () => {
    try {
      parseCliArgs(['--version'])
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(InfoRequest)
      expect((err as Error).message).toMatch(/^better-md \d+\.\d+\.\d+/)
    }
  })

  it('takes update as a subcommand, not a path', () => {
    const opts = parseCliArgs(['update'])
    expect(opts.command).toBe('update')
    expect(opts.target).toBeNull()
  })

  // The escape hatch for the ambiguity: a real path named `update` is reachable
  // by writing it as a path.
  it('treats ./update as a path, not the subcommand', () => {
    const opts = parseCliArgs(['./update'])
    expect(opts.command).toBeNull()
    expect(opts.target).toBe('./update')
  })

  // The help said init "adds" a hook while the default is preview-only, in both
  // the CLI and the docs. Tying the wording to the default keeps the two honest:
  // if the default ever becomes write, this fails and the copy gets revisited.
  it('describes init as previewing, matching its default', () => {
    expect(parseCliArgs(['init', 'claude']).write).toBe(false)
    expect(usage()).toMatch(/init claude\s+preview/i)
  })

  it('takes uninstall as a subcommand', () => {
    const opts = parseCliArgs(['uninstall'])
    expect(opts.command).toBe('uninstall')
    expect(opts.target).toBeNull()
  })

  // Accepted but not advertised: someone will reach for `remove`, and a dead end
  // there is worse than an alias. It maps onto the same command.
  it('accepts remove as an alias for uninstall', () => {
    expect(parseCliArgs(['remove']).command).toBe('uninstall')
  })

  it('treats ./uninstall as a path, not the subcommand', () => {
    expect(parseCliArgs(['./uninstall']).command).toBeNull()
    expect(parseCliArgs(['./uninstall']).target).toBe('./uninstall')
  })

  it('names the actual action when it conflicts with --plan', () => {
    // The message used to hardcode "update", so an uninstall conflict reported
    // the wrong command back at the user.
    expect(() => parseCliArgs(['uninstall', '--plan'])).toThrow(/uninstall cannot be combined/)
    expect(() => parseCliArgs(['update', '--plan'])).toThrow(/update cannot be combined/)
  })

  it('parses --check-updates with no target', () => {
    const opts = parseCliArgs(['--check-updates'])
    expect(opts.checkUpdates).toBe(true)
    expect(opts.command).toBeNull()
  })

  it('rejects combinations that would silently ignore half the input', () => {
    expect(() => parseCliArgs(['--check-updates', 'a.md'])).toThrow(UsageError)
    expect(() => parseCliArgs(['--check-updates', '--plan'])).toThrow(UsageError)
    expect(() => parseCliArgs(['update', '--plan'])).toThrow(UsageError)
  })

  // Typing the bare command is the most likely first thing a new user does. It
  // used to be a dead end — "missing a file or directory argument", exit 1 — so
  // it now orients instead.
  it('shows help for a completely bare invocation', () => {
    expect(() => parseCliArgs([])).toThrow(InfoRequest)
    try {
      parseCliArgs([])
    } catch (err) {
      expect((err as Error).message).toContain('Usage:')
    }
  })

  // But flags with no target are a mistake, not a request for help: someone who
  // typed --no-open meant to open something. Turning that into help would hide
  // the error.
  it('still errors when flags are given without a target', () => {
    expect(() => parseCliArgs(['--no-open'])).toThrow(UsageError)
    expect(() => parseCliArgs(['--port', '3000'])).toThrow(UsageError)
  })

  it('leaves ordinary runs with no command', () => {
    expect(parseCliArgs(['a.md']).command).toBeNull()
    expect(parseCliArgs(['a.md']).checkUpdates).toBe(false)
  })

  describe('--terminal', () => {
    it('parses --terminal and its -t shorthand', () => {
      expect(parseCliArgs(['--terminal', 'a.md']).terminal).toBe(true)
      expect(parseCliArgs(['-t', 'a.md']).terminal).toBe(true)
      expect(parseCliArgs(['a.md']).terminal).toBe(false)
    })

    it('combines --terminal with --plan and --agent', () => {
      const opts = parseCliArgs(['--plan', '--terminal', '--agent', 'cursor'])
      expect(opts).toMatchObject({ plan: true, terminal: true, agent: 'cursor' })
    })

    it('rejects --terminal alongside flags that only make sense for the server', () => {
      // Silently ignoring --port in terminal mode would leave someone believing a
      // server was listening.
      expect(() => parseCliArgs(['--terminal', '--port', '9', 'a.md'])).toThrow(UsageError)
      expect(() => parseCliArgs(['--terminal', '--detach', 'a.md'])).toThrow(UsageError)
    })

    it('names the offending flag so the message is actionable', () => {
      expect(() => parseCliArgs(['--terminal', '--port', '9', 'a.md'])).toThrow(/--port/)
      expect(() => parseCliArgs(['--terminal', '--detach', 'a.md'])).toThrow(/--detach/)
    })

    it('accepts --no-open with --terminal, which opens no browser anyway', () => {
      // Not an error: --no-open asks for no browser, and terminal mode already
      // opens none. Rejecting it would fail scripts that pass it unconditionally.
      expect(parseCliArgs(['--terminal', '--no-open', 'a.md']).terminal).toBe(true)
    })

    it('leaves terminal off for the subcommands', () => {
      expect(parseCliArgs(['update']).terminal).toBe(false)
      expect(parseCliArgs(['init', 'claude']).terminal).toBe(false)
      expect(parseCliArgs(['--check-updates']).terminal).toBe(false)
    })
  })
})
