// Book depreciation for a GPU server (design §2.7): straight line to salvage, in cents, pure.
//
// The close posts these month by month (gpu-dep:<asset>:<YYYY-MM>), not an accounting schedule:
// a schedule holds one fixed amount, so it cannot carry the final-month true-up or stop on disposal.

import { addMonths, monthOf, type MonthKey } from '@/lib/forecast/months'
import { DEFAULT_SALVAGE_RATE, type DepreciationConvention, type GpuAssetRow } from './types'

/** A capitalized cost (decision R8/Q6) and the month it was booked. */
export interface CapexEvent {
  month: MonthKey
  amount: number
}

export interface DepreciableAsset {
  id: string
  /** The cost depreciated from the in-service month: the hardware cost. */
  basis: number
  /** Capex by the month it was booked; it joins the cost from that month on (see depreciationSchedule). */
  capex?: CapexEvent[]
  /** Depreciation already on the books, by month (loadPostedDepreciation). These months are never recomputed. */
  posted?: ReadonlyMap<MonthKey, number>
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

/**
 * The register row as a depreciable asset; null until it has an in-service date. `capex` are the
 * asset's posted capex entries by month (assets.ts loadCapexEvents) and `posted` the depreciation
 * already booked by month (loadPostedDepreciation).
 */
export function depreciableFromAsset(
  row: GpuAssetRow, capex: CapexEvent[] = [], posted?: ReadonlyMap<MonthKey, number>,
): DepreciableAsset | null {
  if (!row.in_service_date) return null
  return {
    id: row.id,
    basis: Number(row.hardware_cost),
    capex,
    posted,
    salvage: Number(row.salvage_value),
    lifeMonths: row.useful_life_months,
    inServiceDate: row.in_service_date,
    convention: row.depreciation_convention,
    disposedOn: row.disposed_on,
  }
}

/**
 * Month-by-month charges, walked in order from the in-service month.
 *
 *   - A month already POSTED carries what the ledger holds. It is never recomputed, whatever has
 *     been booked since.
 *   - While nothing has moved the asset off its original plan (no capex yet, every posted month
 *     as planned), an unposted month takes the §2.7 straight line: `(basis − salvage) / lifeMonths`
 *     in cents, the FINAL month absorbing the rounding.
 *   - Otherwise it takes the REMAINING-LIFE charge: (cost booked by that month − accumulated so far
 *     − salvage) spread over the months left, weighted like the plan. A capex therefore depreciates
 *     prospectively from the first unposted month at or after its own, wherever it is dated, and a
 *     mis-posted month corrects itself over the rest of the life.
 *   - The final month takes whatever is left, so accumulated depreciation ends exactly at
 *     basis + Σ capex − salvage.
 *   - A charge is never negative: when a capex reversal leaves the asset already depreciated past
 *     its cost to date, the remaining months charge 0 rather than writing depreciation back.
 *
 * full_month: `lifeMonths` charges from the in-service month. mid_month: half a charge in the first
 * and last months, `lifeMonths + 1` months. A disposal stops depreciation after the disposal month
 * (half that month's charge under mid_month); the disposal clears what the ledger holds.
 */
export function depreciationSchedule(a: DepreciableAsset): DepreciationLine[] {
  const basis = cents(a.basis)
  const salvage = cents(a.salvage)
  const capex = (a.capex ?? []).map(e => ({ month: e.month, c: cents(e.amount) }))
  const allCapex = capex.reduce((t, e) => t + e.c, 0)
  if (a.lifeMonths <= 0 || basis + allCapex - salvage <= 0) return []

  const weights = a.convention === 'mid_month'
    ? [0.5, ...Array<number>(a.lifeMonths - 1).fill(1), 0.5]
    : Array<number>(a.lifeMonths).fill(1)
  const last = weights.length - 1
  const base = Math.max(0, basis - salvage)
  const monthly = Math.round(base / a.lifeMonths)
  const planned = weights.map(w => Math.round(monthly * w))
  planned[last] = base - planned.slice(0, last).reduce((t, c) => t + c, 0)

  const first = monthOf(a.inServiceDate)
  const out = a.disposedOn ? monthOf(a.disposedOn) : null
  const lines: DepreciationLine[] = []
  let accumulated = 0
  let plannedSoFar = 0
  let onPlan = true
  for (let i = 0; i <= last; i++) {
    const month = addMonths(first, i)
    if (out && month > out) break
    const cost = basis + (i === last ? allCapex : capex.filter(e => e.month <= month).reduce((t, e) => t + e.c, 0))
    const posted = a.posted?.get(month)
    let charge: number
    if (posted !== undefined) charge = cents(posted)
    else if (i === last) charge = Math.max(0, cost - salvage - accumulated)
    else if (onPlan && cost === basis) charge = planned[i]
    else charge = Math.max(0, Math.round(((cost - salvage - accumulated) * weights[i]) / weights.slice(i).reduce((t, w) => t + w, 0)))
    if (posted === undefined && a.convention === 'mid_month' && month === out && i > 0 && i < last) charge = Math.round(charge / 2)
    accumulated += charge
    plannedSoFar += planned[i]
    onPlan = onPlan && cost === basis && accumulated === plannedSoFar
    lines.push({ month, amount: dollars(charge), accumulated: dollars(accumulated), nbv: dollars(cost - accumulated) })
  }
  return lines
}

/**
 * The date a month's depreciation entry carries: its month end, or the disposal date in the month
 * of disposal (min(monthEnd, disposedOn)), so the charge is on the books before the disposal clears.
 */
export function depreciationEntryDate(month: MonthKey, disposedOn?: string | null): string {
  const end = monthEnd(month)
  return disposedOn && monthOf(disposedOn) === month && disposedOn < end ? disposedOn : end
}

/** The charge for one month; 0 outside the schedule. */
export function depreciationForMonth(a: DepreciableAsset, month: MonthKey): number {
  return depreciationSchedule(a).find(l => l.month === month)?.amount ?? 0
}

/** Net book value: cost booked by `date` (basis plus capex) less each charge whose entry date is ≤ `date`. */
export function nbvAsOf(a: DepreciableAsset, date: string): number {
  const cost = cents(a.basis) + (a.capex ?? []).filter(e => e.month <= monthOf(date)).reduce((t, e) => t + cents(e.amount), 0)
  // Each charge counts from its entry date: the month end, or the disposal date in the disposal month.
  const charged = depreciationSchedule(a).filter(l => depreciationEntryDate(l.month, a.disposedOn) <= date).reduce((t, l) => t + cents(l.amount), 0)
  return dollars(cost - charged)
}
