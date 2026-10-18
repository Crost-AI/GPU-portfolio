// The GPU SPV management fee: a share of gross rental revenue, month by month.
//
// The fee is an expense of the SPV, outside the distribution split. It is charged on revenue
// only, never on sale proceeds (4500) or interest (4100): the accrual that ships with the ledger
// wiring reads posted revenue in `revenueSubtypes`, so those accounts are outside the basis by
// construction. This file is the pure arithmetic both the accrual and the scenario engine use.

import { roundCents } from '@/lib/accounting/ledger'
import type { MonthKey } from '@/lib/forecast/months'

export const DEFAULT_FEE_REVENUE_SUBTYPES = ['rental_revenue']

export interface VehicleFeeTerms {
  basis: 'gross_revenue'
  /** Share of each month's gross revenue, e.g. 0.05. Not divided by 12: it applies to revenue. */
  annualRate: number
  /** Account subtypes whose posted revenue is the basis; `DEFAULT_FEE_REVENUE_SUBTYPES` by default. */
  revenueSubtypes: string[]
  frequency: 'monthly' | 'quarterly' | 'annual'
  /** The management company's vehicle when the fee is booked intercompany; else null (2100). */
  payeeVehicleId: string | null
}

/** The fee for each month: roundCents(rate × that month's revenue). */
export function grossRevenueFee(terms: VehicleFeeTerms, revenueByMonth: Map<MonthKey, number>): Map<MonthKey, number> {
  const out = new Map<MonthKey, number>()
  for (const [month, revenue] of revenueByMonth) out.set(month, roundCents(terms.annualRate * revenue))
  return out
}
