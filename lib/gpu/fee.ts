// The GPU SPV management fee: a share of gross rental revenue, month by month.
//
// The fee is an expense of the SPV, outside the distribution split. It is charged on revenue
// only, never on sale proceeds (4500) or interest (4100): the accrual that ships with the ledger
// wiring reads posted revenue in `revenueSubtypes`, so those accounts are outside the basis by
// construction. This file is the pure arithmetic both the accrual and the scenario engine use.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundCents } from '@/lib/accounting/ledger'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import type { MonthKey } from '@/lib/forecast/months'

export const DEFAULT_FEE_REVENUE_SUBTYPES = ['rental_revenue']

/** `vehicle_fee_terms.basis`. Only gross_revenue is accrued by this module (a GPU SPV's fee). */
export const FEE_BASES = ['committed', 'invested', 'nav', 'gross_revenue'] as const
export type FeeBasis = (typeof FEE_BASES)[number]
export const FEE_FREQUENCIES = ['monthly', 'quarterly'] as const

export interface VehicleFeeTerms {
  basis: FeeBasis
  /** Share of each month's gross revenue, e.g. 0.05. Not divided by 12: it applies to revenue. */
  annualRate: number
  /** Account subtypes whose posted revenue is the basis; `DEFAULT_FEE_REVENUE_SUBTYPES` by default. */
  revenueSubtypes: string[]
  frequency: (typeof FEE_FREQUENCIES)[number]
  /** The management company's vehicle when the fee is booked intercompany; else null (2100). */
  payeeVehicleId: string | null
  effectiveFrom?: string
  effectiveTo?: string | null
}

/** The vehicle's `vehicle_fee_terms` row, or null when it has none. A failed read throws. */
export async function loadFeeTerms(admin: SupabaseClient, fundId: string, group: string): Promise<VehicleFeeTerms | null> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  if (!vehicleId) return null
  const { data, error } = await (admin as any)
    .from('vehicle_fee_terms')
    .select('basis, annual_rate, revenue_subtypes, frequency, payee_vehicle_id, effective_from, effective_to')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    .maybeSingle()
  if (error) throw new Error(`vehicle_fee_terms read failed: ${error.message}`)
  if (!data) return null
  return {
    basis: data.basis,
    annualRate: Number(data.annual_rate),
    revenueSubtypes: Array.isArray(data.revenue_subtypes) && data.revenue_subtypes.length > 0 ? data.revenue_subtypes : DEFAULT_FEE_REVENUE_SUBTYPES,
    frequency: data.frequency === 'quarterly' ? 'quarterly' : 'monthly',
    payeeVehicleId: data.payee_vehicle_id ?? null,
    effectiveFrom: data.effective_from,
    effectiveTo: data.effective_to ?? null,
  }
}

/** The fee for each month: roundCents(rate × that month's revenue). */
export function grossRevenueFee(terms: VehicleFeeTerms, revenueByMonth: Map<MonthKey, number>): Map<MonthKey, number> {
  const out = new Map<MonthKey, number>()
  for (const [month, revenue] of revenueByMonth) out.set(month, roundCents(terms.annualRate * revenue))
  return out
}
