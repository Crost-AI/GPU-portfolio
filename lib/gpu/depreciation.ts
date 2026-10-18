// Book depreciation for a GPU server (design §2.7): straight line to salvage, in cents, pure.
//
// The close posts these month by month (gpu-dep:<asset>:<YYYY-MM>), not an accounting schedule:
// a schedule holds one fixed amount, so it cannot carry the final-month true-up or stop on disposal.

import { addMonths, monthOf, type MonthKey } from '@/lib/forecast/months'
import { DEFAULT_SALVAGE_RATE, type DepreciationConvention, type GpuAssetRow } from './types'

export interface DepreciableAsset {
  id: string
  /** hardware_cost + capitalized_costs. */
  basis: number
  salvage: number
  lifeMonths: number
  inServiceDate: string
  convention: DepreciationConvention
  disposedOn?: string | null
}

export interface DepreciationLine {
  month: MonthKey
  amount: number
  accumulated: number
  nbv: number
}

const cents = (n: number) => Math.round(n * 100)
const dollars = (c: number) => c / 100

/** The last day of a month, ISO. Depreciation for a month is dated at its end. */
export function monthEnd(month: MonthKey): string {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}

export function defaultSalvage(hardwareCost: number): number {
  return dollars(cents(hardwareCost * DEFAULT_SALVAGE_RATE))
}

/** The register row as a depreciable asset; null until it has an in-service date. */
export function depreciableFromAsset(row: GpuAssetRow): DepreciableAsset | null {
  if (!row.in_service_date) return null
  return {
    id: row.id,
    basis: dollars(cents(Number(row.hardware_cost)) + cents(Number(row.capitalized_costs ?? 0))),
    salvage: Number(row.salvage_value),
    lifeMonths: row.useful_life_months,
    inServiceDate: row.in_service_date,
    convention: row.depreciation_convention,
    disposedOn: row.disposed_on,
  }
}

/**
 * Month-by-month charges. `(basis − salvage) / lifeMonths` rounded to cents, with the FINAL month
 * absorbing the rounding so accumulated depreciation ends exactly at `basis − salvage`.
 *
 *   - full_month: the first charge falls in the in-service month; `lifeMonths` charges.
 *   - mid_month: half a charge in the first and last months; `lifeMonths + 1` months.
 *
 * A disposal stops depreciation after the disposal month (half a month there under mid_month), and
 * the true-up is then never reached: the disposal entry clears what the ledger actually holds.
 */
export function depreciationSchedule(a: DepreciableAsset): DepreciationLine[] {
  const total = cents(a.basis) - cents(a.salvage)
  if (total <= 0 || a.lifeMonths <= 0) return []
  const monthly = Math.round(total / a.lifeMonths)
  const half = Math.round(monthly / 2)
  const charges = a.convention === 'mid_month'
    ? [half, ...Array<number>(a.lifeMonths - 1).fill(monthly), half]
    : Array<number>(a.lifeMonths).fill(monthly)
  const last = charges.length - 1
  charges[last] = total - charges.slice(0, last).reduce((s, c) => s + c, 0)

  const first = monthOf(a.inServiceDate)
  let months = charges.map((amount, i) => ({ month: addMonths(first, i), amount }))
  if (a.disposedOn) {
    const out = monthOf(a.disposedOn)
    months = months.filter(m => m.month <= out)
    const i = months.length - 1
    if (a.convention === 'mid_month' && i > 0 && i < last && months[i].month === out) months[i] = { ...months[i], amount: half }
  }

  let accumulated = 0
  return months.map(({ month, amount }) => {
    accumulated += amount
    return { month, amount: dollars(amount), accumulated: dollars(accumulated), nbv: dollars(cents(a.basis) - accumulated) }
  })
}

/** The charge for one month; 0 outside the schedule. */
export function depreciationForMonth(a: DepreciableAsset, month: MonthKey): number {
  return depreciationSchedule(a).find(l => l.month === month)?.amount ?? 0
}

/** Net book value per the schedule, counting each month's charge once its month end is ≤ `date`. */
export function nbvAsOf(a: DepreciableAsset, date: string): number {
  let nbv = a.basis
  for (const line of depreciationSchedule(a)) {
    if (monthEnd(line.month) > date) break
    nbv = line.nbv
  }
  return nbv
}
