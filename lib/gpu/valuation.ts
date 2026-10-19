// ── GPU fleet (P1) ── The register's valuation of each server as of a date (#95), computed on the
// server so every surface shows the same figures: the book side from the remaining-life schedule on
// the posted state with prospective capex (depreciation.ts), the tax side from the asset's own tax
// method (tax-depreciation.ts). One ledger read per vehicle (fleet-ledger.ts), never per asset.

import type { SupabaseClient } from '@supabase/supabase-js'
import { depreciableFromAsset, nbvAsOf } from './depreciation'
import { loadFleetLedger } from './fleet-ledger'
import { taxDepreciationSchedule } from './tax-depreciation'
import type { GpuAssetRow } from './types'

export interface AssetValuation {
  /** hardware_cost + capitalized_costs, as of `valuation_as_of`. */
  basis: number
  /** Posted capex net of reversals, as of `valuation_as_of`. */
  capitalized_costs: number
  accumulated_book: number
  nbv_book: number
  /** For tax_method 'book', equal to the book figures. Through the tax year containing the date. */
  accumulated_tax: number
  nbv_tax: number
  valuation_as_of: string
  capex_events: { month: string; amount: number; source_ref: string; posted_at: string | null }[]
}

const cents = (n: number) => Math.round(n * 100)
const dollars = (c: number) => c / 100

/** `raw` as a real YYYY-MM-DD date, today when absent, or null when it is not one. */
export function parseAsOf(raw: string | null): string | null {
  if (raw == null || raw === '') return new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const d = new Date(`${raw}T00:00:00Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw ? null : raw
}

/**
 * Each asset's valuation as of `asOf`.
 *   - basis: hardware cost plus the capex posted by then; capex joins depreciation prospectively.
 *   - book: accumulated = basis − nbvAsOf on the remaining-life schedule (posted months as posted).
 *   - tax: the asset's tax method on the same basis, summed through the tax year containing `asOf`;
 *     tax_method 'book' reports the book figures.
 *   - before in service nothing is depreciated; on or after its disposal, both NBVs are 0.
 */
export async function valueAssets(
  admin: SupabaseClient, fundId: string, vehicleId: string, rows: GpuAssetRow[], asOf: string,
): Promise<Map<string, AssetValuation>> {
  const ledger = await loadFleetLedger(admin, fundId, vehicleId, asOf, rows)
  const out = new Map<string, AssetValuation>()
  for (const l of ledger.assets) {
    const a = l.asset
    const capexCents = l.capex.reduce((t, e) => t + cents(e.amount), 0)
    const basisCents = cents(Number(a.hardware_cost)) + capexCents
    const disposed = !!a.disposed_on && a.disposed_on <= asOf
    const dep = depreciableFromAsset(a, l.capex, l.posted)
    // The schedule stops at the disposal; once disposed the asset is off the books (NBV 0).
    const scheduleNbv = dep ? cents(nbvAsOf(dep, asOf)) : basisCents
    const accBook = basisCents - scheduleNbv
    const nbvBook = disposed ? 0 : scheduleNbv

    let accTax = accBook
    let nbvTax = nbvBook
    if (a.tax_method !== 'book' && dep) {
      const year = Number(asOf.slice(0, 4))
      accTax = taxDepreciationSchedule({
        ...dep, basis: dollars(basisCents), capex: [], taxMethod: a.tax_method, taxBonusPct: Number(a.tax_bonus_pct ?? 0), taxLifeYears: a.tax_life_years,
      }).filter(y => y.year <= year).reduce((t, y) => t + cents(y.amount), 0)
      nbvTax = disposed ? 0 : Math.max(0, basisCents - accTax)
    }
    out.set(a.id, {
      basis: dollars(basisCents), capitalized_costs: dollars(capexCents),
      accumulated_book: dollars(accBook), nbv_book: dollars(nbvBook),
      accumulated_tax: dollars(accTax), nbv_tax: dollars(nbvTax),
      valuation_as_of: asOf,
      capex_events: l.capex.map(e => ({ month: e.month, amount: e.amount, source_ref: e.source_ref, posted_at: e.posted_at })),
    })
  }
  return out
}
