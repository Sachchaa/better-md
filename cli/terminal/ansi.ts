/**
 * Escape sequences and terminal capability detection.
 *
 * Hand-written rather than pulled from a package: this project ships zero
 * runtime dependencies inside a checksum-verified binary people install with
 * `curl | sh`, and the sequences needed here are a dozen constants.
 */

const ESC = '\x1b['

const SGR = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  inverse: 7,
} as const

export type SGRName = keyof typeof SGR

let colourEnabled = true

/** Set once at startup from `supportsColour`. */
export function setColourEnabled(on: boolean): void {
  colourEnabled = on
}

export function style(text: string, code: SGRName, opts?: { enabled?: boolean }): string {
  const on = opts?.enabled ?? colourEnabled
  return on ? `${ESC}${SGR[code]}m${text}${ESC}${SGR.reset}m` : text
}

/**
 * Whether to emit colour at all.
 *
 * NO_COLOR is honoured because output may be piped or captured, where escape
 * codes are noise rather than styling. An unset TERM means we cannot assume
 * anything about the receiver.
 */
export function supportsColour(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (!isTty) return false
  return env.TERM !== undefined && env.TERM !== '' && env.TERM !== 'dumb'
}

/**
 * Whether box-drawing and check marks will render.
 *
 * Locale precedence follows POSIX: LC_ALL wins, then LC_CTYPE, then LANG. A
 * terminal that cannot show `✓` shows a mojibake box instead, which is worse
 * than the ASCII fallback.
 */
export function supportsUnicode(env: NodeJS.ProcessEnv): boolean {
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? ''
  return /UTF-?8/i.test(locale)
}

export const ALT_SCREEN_ON = `${ESC}?1049h`
export const ALT_SCREEN_OFF = `${ESC}?1049l`
export const CURSOR_HIDE = `${ESC}?25l`
export const CURSOR_SHOW = `${ESC}?25h`
export const CLEAR = `${ESC}2J${ESC}H`
export const CLEAR_LINE = `${ESC}2K`

export function moveTo(row: number, col = 1): string {
  return `${ESC}${row};${col}H`
}
