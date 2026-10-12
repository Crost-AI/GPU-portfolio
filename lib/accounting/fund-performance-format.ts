// The fund performance report's shape and its formatting, with no server imports, so the page
// and the PDF builder print the same figures the same way. See fund-performance.ts.

import { getCurrencySymbol } from '@/lib/currency'

export type PerformanceGrouping = 'date' | 'month' | 'quarter'

export const PERFORMANCE_GROUPINGS: PerformanceGrouping[] = ['date', 'month', 'quarter']

export interface PerformanceRow {
  /** What the row covers: a date, "Aug 2021", or "Q3 2021". */
  label: string
  /** The last activity date inside the row. */
  date: string
  contributions: number
  distributions: number
  /** From the LP's side: distributions less contributions. */
  net: number
}

export interface FundPerformanceReport {
  vehicle: string
  asOf: string
  /** "Q4 2025" when the date is a quarter end, otherwise the date itself. */
  periodLabel: string
  grouping: PerformanceGrouping
  rows: PerformanceRow[]
  /** Totals of the rows, plus the NAV as the terminal value. */
  totals: { contributions: number; distributions: number; nav: number; net: number }
  /** The LP-only figures. Ratios are null when nothing has been paid in. */
  metrics: {
    committed: number
    contributions: number | null
    distributions: number | null
    nav: number | null
    totalValue: number | null
    irr: number | null
    tvpi: number | null
    dpi: number | null
    rvpi: number | null
  }
  /** Plain sentences a reader should see before trusting the page. Empty when clean. */
  notes: string[]
}

/** "Q4 2025" when `asOf` is a calendar quarter end, else the ISO date. */
export function periodLabel(asOf: string): string {
  const [y, m, d] = asOf.split('-').map(Number)
  const quarterEnd = { 3: 31, 6: 30, 9: 30, 12: 31 } as Record<number, number>
  return quarterEnd[m] === d ? `Q${m / 3} ${y}` : asOf
}

/** The most recent calendar quarter end on or before `today` (YYYY-MM-DD). */
export function lastQuarterEnd(today: string): string {
  const [y, m, d] = today.split('-').map(Number)
  const ends: [number, number, number][] = [[y, 12, 31], [y, 9, 30], [y, 6, 30], [y, 3, 31], [y - 1, 12, 31]]
  const hit = ends.find(([ey, em, ed]) => ey < y || em < m || (em === m && ed <= d))!
  return `${hit[0]}-${String(hit[1]).padStart(2, '0')}-${String(hit[2]).padStart(2, '0')}`
}

/** Whole currency in the table, negatives in parentheses, a dash for zero — as the Carta page.
 *  The summary passes `dp = 2`, where a zero is a stated figure and prints as one. */
export function performanceMoney(v: number | null | undefined, currency: string, dp = 0): string {
  if (v == null) return '—'
  if (Math.abs(v) < 0.005 && dp === 0) return '—'
  const n = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
  const sym = getCurrencySymbol(currency)
  return v < 0 ? `(${sym}${n})` : `${sym}${n}`
}

export const performanceMultiple = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}x`)
export const performancePct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`)

