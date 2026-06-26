/* Shared Tailwind class fragments (theme-variable driven). */

export const SEG_BASE =
  'cursor-pointer font-medium text-[12px] leading-none font-sans px-[11px] py-[6px] rounded-[7px] transition-colors duration-[120ms] border-0'
export const SEG_ON =
  SEG_BASE + ' bg-[var(--panel)] text-[var(--fg)] shadow-[0_1px_2px_rgba(0,0,0,0.10)]'
export const SEG_OFF = SEG_BASE + ' bg-transparent text-[var(--muted)]'

export const TB_BTN =
  'inline-flex items-center justify-center min-w-[30px] h-[28px] px-[7px] border border-transparent rounded-[7px] bg-transparent text-[var(--muted)] font-medium text-[12px] leading-none font-sans cursor-pointer hover:bg-[var(--panel2)] hover:text-[var(--fg)]'

export const LABEL =
  'font-semibold text-[11px] leading-none font-sans tracking-[0.09em] uppercase text-[var(--muted)]'
