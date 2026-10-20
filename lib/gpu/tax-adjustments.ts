// ── GPU fleet (P1c) ── A GPU SPV's book-to-tax differences for one tax year, per server (#68).
//
// The books depreciate each server straight line to salvage (the gpu-dep entries the close posts);
// the return takes the asset's own tax method (tax-depreciation.ts). The tax book records the
// difference, so actual + tax is tax depreciation:
//
//   - depreciation: the year's tax depreciation less the book depreciation POSTED in the year. What
//     the close actually booked is the reference, not the plan, so a month the close missed is
//     corrected here rather than carried as a difference nobody can see.
//   - disposal basis: a server disposed of in the year leaves the books with book accumulated
//     depreciation; for tax it left with tax accumulated depreciation, so the tax gain differs from
//     the book gain by the cumulative difference. Reversing it into the gain also clears the server's
//     1650 account in the tax book. It assumes each earlier year's run was posted, which is what
//     put the earlier differences there.
//
// A server whose tax method is 'book' has no difference, and one not on the books by year end (not
// purchased, or its purchase reversed) has nothing to adjust.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadFleetLedger } from './fleet-ledger'
import { taxDepreciationByYear } from './valuation'

export interface FleetDepreciationDifference {
  assetId: string
  name: string
  /** The server's 1650 sub-account, which the difference adjusts. */
  accumulatedAccountId: string
  book: number
  tax: number
  /** tax − book. Positive: the return deducts more than the books expensed. */
  difference: number
}

export interface FleetTaxYear {
  depreciation: FleetDepreciationDifference[]
  /** Cumulative tax − book accumulated depreciation of each server disposed of in the year. */
  disposals: FleetDepreciationDifference[]
}

const dollars = (c: number) => c / 100
const cents = (n: number) => Math.round(n * 100)

export async function loadFleetTaxYear(
  admin: SupabaseClient, fundId: string, vehicleId: string, taxYear: number,
): Promise<FleetTaxYear> {
  const yearStart = `${taxYear}-01-01`
  const yearEnd = `${taxYear}-12-31`
  const { assets } = await loadFleetLedger(admin, fundId, vehicleId, yearEnd)
  const out: FleetTaxYear = { depreciation: [], disposals: [] }
  for (const l of assets) {
    const a = l.asset
    if (!l.purchase || !l.accumulatedAccountId || !a.in_service_date || a.tax_method === 'book') continue
    if (a.disposed_on && a.disposed_on < yearStart) continue
    const tax = taxDepreciationByYear(l)
    const posted = Array.from(l.posted.entries())
    const bookInYear = posted.filter(([m]) => m.startsWith(`${taxYear}-`)).reduce((t, [, v]) => t + cents(v), 0)
    const taxInYear = tax.get(taxYear) ?? 0
    const line = (book: number, taxC: number): FleetDepreciationDifference => ({
      assetId: a.id, name: a.name, accumulatedAccountId: l.accumulatedAccountId!,
      book: dollars(book), tax: dollars(taxC), difference: dollars(taxC - book),
    })
    if (taxInYear !== bookInYear) out.depreciation.push(line(bookInYear, taxInYear))
    if (a.disposed_on && a.disposed_on <= yearEnd) {
      const bookToDate = posted.reduce((t, [, v]) => t + cents(v), 0)
      const taxToDate = Array.from(tax.entries()).filter(([y]) => y <= taxYear).reduce((t, [, c]) => t + c, 0)
      if (taxToDate !== bookToDate) out.disposals.push(line(bookToDate, taxToDate))
    }
  }
  return out
}
