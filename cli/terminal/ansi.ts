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
 * How much colour the receiving terminal can show.
 *
 * Three tiers rather than on/off, because the fallbacks matter: a plain `xterm`
 * over ssh is common and still does the basic sixteen, and refusing colour there
 * would leave the most ordinary remote session monochrome.
 */
export type ColourDepth = 'truecolor' | 'ansi256' | 'basic' | 'none'

export function colourDepth(env: NodeJS.ProcessEnv, isTty: boolean): ColourDepth {
  if (!supportsColour(env, isTty)) return 'none'
  const colorterm = env.COLORTERM ?? ''
  if (/truecolor|24bit/i.test(colorterm)) return 'truecolor'
  if (/256/.test(env.TERM ?? '')) return 'ansi256'
  return 'basic'
}

/**
 * One colour, expressed for every tier.
 *
 * The 256 index and the basic code are chosen by hand rather than computed: a
 * nearest-neighbour search over the xterm cube picks technically-closest values
 * that look muddy, and there are only six colours here.
 */
export interface Colour {
  r: number
  g: number
  b: number
  ansi256: number
  basic: number
}

/**
 * The renderer's whole colour vocabulary.
 *
 * `brand` is the logo's green, so a rendered plan and the website agree. `code`
 * is deliberately a different hue: inline code appears constantly, and in the
 * brand colour it would compete with every heading on the page.
 */
export const PALETTE = {
  brand: { r: 0xa8, g: 0xe0, b: 0x63, ansi256: 149, basic: 92 },
  code: { r: 0x7a, g: 0xa2, b: 0xf7, ansi256: 111, basic: 94 },
  text: { r: 0xd7, g: 0xd7, b: 0xd7, ansi256: 252, basic: 97 },
  muted: { r: 0x8a, g: 0x8a, b: 0x8a, ansi256: 245, basic: 90 },
  border: { r: 0x4a, g: 0x52, b: 0x57, ansi256: 239, basic: 90 },
  link: { r: 0x86, g: 0xd0, b: 0xc8, ansi256: 115, basic: 96 },
} as const satisfies Record<string, Colour>

/**
 * Wrap `text` in a foreground colour.
 *
 * Closed with 39 (default foreground) rather than 0 (reset everything), so a
 * colour nested inside bold does not strip the weight from that point on.
 */
export function paint(text: string, colour: Colour, depth: ColourDepth): string {
  if (depth === 'none') return text
  const open =
    depth === 'truecolor'
      ? `38;2;${colour.r};${colour.g};${colour.b}`
      : depth === 'ansi256'
        ? `38;5;${colour.ansi256}`
        : `${colour.basic}`
  return `${ESC}${open}m${text}${ESC}39m`
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
