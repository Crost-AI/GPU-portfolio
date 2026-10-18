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
  /** The cost depreciated from the in-service month: hardware cost (plus any capex not given as events). */
  basis: number
  /** Capex depreciated PROSPECTIVELY from its month over the remaining life; see depreciationSchedule. */
  capex?: CapexEvent[]
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
 * The register row as a depreciable asset; null until it has an in-service date.
 *
 * `capex` are the asset's posted capex entries by month (assets.ts loadCapexEvents), each then
 * depreciated prospectively. Without them, `capitalized_costs` is treated as spent at in-service,
 * which is right only for costs booked before the first depreciation month.
 */
export function depreciableFromAsset(row: GpuAssetRow, capex?: CapexEvent[]): DepreciableAsset | null {
  if (!row.in_service_date) return null
  return {
    id: row.id,
    basis: capex ? Number(row.hardware_cost) : dollars(cents(Number(row.hardware_cost)) + cents(Number(row.capitalized_costs ?? 0))),
    capex,
    salvage: Number(row.salvage_value),
    lifeMonths: row.useful_life_months,
    inServiceDate: row.in_service_date,
    convention: row.depreciation_convention,
    disposedOn: row.disposed_on,
  }
}

const monthIndex = (m: MonthKey) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1

/**
 * Month-by-month charges. `(basis − salvage) / lifeMonths` rounded to cents, with the FINAL month
 * absorbing the rounding so accumulated depreciation ends exactly at `basis + Σ capex − salvage`.
 *
 *   - full_month: the first charge falls in the in-service month; `lifeMonths` charges.
 *   - mid_month: half a charge in the first and last months; `lifeMonths + 1` months.
 *   - capex is PROSPECTIVE: a cost booked in month k adds `amount / (months remaining from k)` to
 *     each charge from k on (weighted like the base charges, so a mid_month final half stays half).
 *     Months before k are never rewritten, so what the close already posted stays right. A cost
 *     booked before in-service spreads over the whole life; one after the last month lands in it.
 *
 * A disposal stops depreciation after the disposal month (half that month's charge under
 * mid_month), and the true-up is then never reached: the disposal clears what the ledger holds.
 */
export function depreciationSchedule(a: DepreciableAsset): DepreciationLine[] {
  const base = cents(a.basis) - cents(a.salvage)
  const capex = (a.capex ?? []).map(e => ({ month: e.month, c: cents(e.amount) }))
  const total = base + capex.reduce((t, e) => t + e.c, 0)
  if (total <= 0 || a.lifeMonths <= 0) return []
  const monthly = Math.round(base / a.lifeMonths)
  const weights = a.convention === 'mid_month'
    ? [0.5, ...Array<number>(a.lifeMonths - 1).fill(1), 0.5]
    : Array<number>(a.lifeMonths).fill(1)
  const charges = weights.map(w => Math.round(monthly * w))
  const last = charges.length - 1

  const first = monthOf(a.inServiceDate)
  for (const e of capex) {
    const k = Math.min(last, Math.max(0, monthIndex(e.month) - monthIndex(first)))
    const share = e.c / weights.slice(k).reduce((t, w) => t + w, 0)
    for (let j = k; j < last; j++) charges[j] += Math.round(share * weights[j])
  }
  charges[last] = total - charges.slice(0, last).reduce((t, c) => t + c, 0)

  let months = charges.map((amount, i) => ({ month: addMonths(first, i), amount }))
  if (a.disposedOn) {
    const out = monthOf(a.disposedOn)
    months = months.filter(m => m.month <= out)
    const i = months.length - 1
    if (a.convention === 'mid_month' && i > 0 && i < last && months[i].month === out) months[i] = { ...months[i], amount: Math.round(months[i].amount / 2) }
  }

  // NBV counts the cost on the books by each month: the basis plus capex booked by then.
  const costBy = (month: MonthKey) => cents(a.basis) + capex.filter(e => e.month <= month).reduce((t, e) => t + e.c, 0)
  let accumulated = 0
  return months.map(({ month, amount }) => {
    accumulated += amount
    return { month, amount: dollars(amount), accumulated: dollars(accumulated), nbv: dollars(costBy(month) - accumulated) }
  })
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

/** Net book value: cost booked by `date` (basis plus capex) less each month's charge whose month end is ≤ `date`. */
export function nbvAsOf(a: DepreciableAsset, date: string): number {
  const cost = cents(a.basis) + (a.capex ?? []).filter(e => e.month <= monthOf(date)).reduce((t, e) => t + cents(e.amount), 0)
  const charged = depreciationSchedule(a).filter(l => monthEnd(l.month) <= date).reduce((t, l) => t + cents(l.amount), 0)
  return dollars(cost - charged)
}
