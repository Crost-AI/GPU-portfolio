// Tax depreciation for a GPU server, kept separately from book (decision Q7), pure.
//
// The SPV takes bonus/MACRS on its return while the books depreciate straight line to salvage, so
// each asset carries its own tax method and the difference per tax year is a book-to-tax item.
// Wiring that difference into the book-to-tax run and K-1s is a follow-up (#68).
//
// HALF-YEAR CONVENTION ONLY. The mid-quarter convention (§168(d)(3): more than 40% of a year's
// depreciable basis placed in service in Q4, Pub. 946 Tables A-2 to A-5) is not supported; a fleet
// that goes live late in the year needs the preparer to check it. Tracked on #68.

import { depreciableFromAsset, depreciationSchedule, type DepreciableAsset } from './depreciation'
import type { GpuAssetRow, TaxMethod } from './types'

/** IRS Pub. 946 Table A-1: 200% declining balance, half-year convention. Percent of basis by year. */
export const MACRS_HALF_YEAR: Record<5 | 7, number[]> = {
  5: [20.0, 32.0, 19.2, 11.52, 11.52, 5.76],
  7: [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46],
}

export interface TaxDepreciableAsset extends DepreciableAsset {
  taxMethod: TaxMethod
  /** 0..1, for 'bonus'. */
  taxBonusPct: number
  /** The MACRS class for 'bonus' (5 or 7; 5 when unset), the recovery period for 'straight_line'. */
  taxLifeYears: number | null
}

export interface TaxYearLine {
  year: number
  amount: number
  accumulated: number
}

const cents = (n: number) => Math.round(n * 100)
const dollars = (c: number) => c / 100
const yearOf = (iso: string) => Number(iso.slice(0, 4))

export function taxDepreciableFromAsset(row: GpuAssetRow): TaxDepreciableAsset | null {
  const book = depreciableFromAsset(row)
  if (!book) return null
  return { ...book, taxMethod: row.tax_method, taxBonusPct: Number(row.tax_bonus_pct ?? 0), taxLifeYears: row.tax_life_years }
}

function byCalendarYear(lines: { month: string; amount: number }[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const l of lines) out.set(Number(l.month.slice(0, 4)), (out.get(Number(l.month.slice(0, 4))) ?? 0) + cents(l.amount))
  return out
}

/** A MACRS table applied to `basisCents`, the last year absorbing the rounding. */
function macrs(basisCents: number, cls: 5 | 7): number[] {
  const table = MACRS_HALF_YEAR[cls]
  const out = table.map(pct => Math.round((basisCents * pct) / 100))
  out[out.length - 1] = basisCents - out.slice(0, -1).reduce((s, c) => s + c, 0)
  return out
}

/**
 * Annual tax depreciation by calendar year, year 1 being the year placed in service.
 *
 *   - book: the book schedule, summed by calendar year.
 *   - straight_line: straight line over `taxLifeYears` (book life when unset) from the in-service
 *     month, with no salvage (tax recovers the full basis).
 *   - macrs_5 / macrs_7: the half-year table on the full basis.
 *   - bonus: `taxBonusPct` of the basis in year 1, then MACRS (`taxLifeYears` 7, else 5) on the rest.
 *
 * A MACRS or bonus asset disposed of in a later year takes half that year's amount and nothing
 * after (half-year convention), except in the table's final year, whose percentage is already the
 * half year left (Pub. 946 ch. 4, year of disposition), so it is taken in full. One disposed of in
 * the year placed in service takes none.
 */
export function taxDepreciationSchedule(a: TaxDepreciableAsset): TaxYearLine[] {
  // A non-book tax method runs on its own inputs, never the book postings or book capex events
  // (decision Q7). The 'book' method IS the book schedule, so it keeps them: tax equals book.
  if (a.taxMethod !== 'book') a = { ...a, posted: undefined, capex: [] }
  const basis = cents(a.basis)
  const start = yearOf(a.inServiceDate)
  let years: Map<number, number>

  if (a.taxMethod === 'book') {
    years = byCalendarYear(depreciationSchedule(a))
  } else if (a.taxMethod === 'straight_line') {
    const lifeMonths = a.taxLifeYears ? a.taxLifeYears * 12 : a.lifeMonths
    years = byCalendarYear(depreciationSchedule({ ...a, salvage: 0, lifeMonths, convention: 'full_month' }))
  } else {
    const cls: 5 | 7 = a.taxMethod === 'macrs_7' || (a.taxMethod === 'bonus' && a.taxLifeYears === 7) ? 7 : 5
    const bonus = a.taxMethod === 'bonus' ? Math.round(basis * a.taxBonusPct) : 0
    const amounts = macrs(basis - bonus, cls)
    amounts[0] += bonus
    years = new Map(amounts.map((c, i) => [start + i, c]))
    if (a.disposedOn) {
      const out = yearOf(a.disposedOn)
      const finalYear = start + amounts.length - 1
      for (const y of Array.from(years.keys())) {
        if (y > out || out === start) years.delete(y)
        else if (y === out && y !== finalYear) years.set(y, Math.round(years.get(y)! / 2))
      }
    }
  }

  let accumulated = 0
  return Array.from(years.entries()).sort(([x], [y]) => x - y).map(([year, c]) => {
    accumulated += c
    return { year, amount: dollars(c), accumulated: dollars(accumulated) }
  })
}

/**
 * Book and tax depreciation for one tax year and their difference (tax − book). Positive: the
 * return deducts more than the books expensed, so taxable income is below book income.
 */
export function bookToTaxDepreciation(a: TaxDepreciableAsset, taxYear: number): { book: number; tax: number; difference: number } {
  const book = byCalendarYear(depreciationSchedule(a)).get(taxYear) ?? 0
  const tax = cents(taxDepreciationSchedule(a).find(l => l.year === taxYear)?.amount ?? 0)
  return { book: dollars(book), tax: dollars(tax), difference: dollars(tax - book) }
}
