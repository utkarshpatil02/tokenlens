/**
 * Display helpers.
 *
 * Money crosses the wire as an exact decimal string. These convert to a float
 * only for rendering; the float is never stored back.
 */

export const money = (value: string): number => Number.parseFloat(value)

/** Sub-cent figures need more places, or a real cost renders as "$0.00". */
export const usd = (value: string | number): string => {
  const n = typeof value === 'string' ? money(value) : value
  if (n === 0) return '$0'
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`
  if (Math.abs(n) < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

export const pct = (share: number): string => `${(share * 100).toFixed(1)}%`

export const tokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

export const compact = (n: number): string => n.toLocaleString()

export const TIER_LABEL: Record<number, string> = {
  1: 'tier 1 · small',
  2: 'tier 2 · mid',
  3: 'tier 3 · frontier',
}

export const BAND_COLOR: Record<string, string> = {
  efficient: 'var(--ok)',
  moderate: 'var(--warn)',
  high: 'var(--bad)',
  critical: 'var(--crit)',
}

/** Categorical series colours, used in fixed order for chart stability. */
export const SERIES = [
  'var(--c1)',
  'var(--c2)',
  'var(--c3)',
  'var(--c4)',
  'var(--c5)',
]

export const truncate = (text: string, max = 90): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text
