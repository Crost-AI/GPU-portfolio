// ── GPU fleet (P1) ── The fleet's part of the period close (design §4.5): the monthly depreciation
// the close proposes, and the two review checks it blocks on. Only a gpu_spv vehicle has any; every
// other vehicle gets nothing from here, so its close is unchanged.
//
// Each booked asset (purchase linked, in service) is read once: its capex, the depreciation already
// posted by month and every gpu-dep entry under its ref, and the remaining-life schedule built on
// that posted state (lib/gpu/depreciation.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { assetAccountCode } from '@/lib/accounting/chart'
import type { CloseEntrySuggestion } from '@/lib/accounting/close-suggestions'
import { loadPostedLedger } from '@/lib/accounting/load'
import { reversalRef } from '@/lib/accounting/reversal'
import { monthOf } from '@/lib/forecast/months'
import { isGpuSpv } from '@/lib/vehicle-kinds'
import { ACCUMULATED_BASE, COST_BASE, accountIdsByCode, listAssets, loadCapexEvents, loadPostedDepreciation, type Lifecycle } from './assets'
import { depreciableFromAsset, depreciationEntryDate, depreciationSchedule, nbvAsOf, type DepreciationLine } from './depreciation'
import { assetBalances } from './disposal'
import { buildDepreciationEntry, gpuSourceRef } from './entries'
import type { GpuAssetRow } from './types'

export const DEPRECIATION_EXPENSE_CODE = '5300'

interface AssetState {
  asset: GpuAssetRow
  accumulatedAccountId: string
  schedule: DepreciationLine[]
  posted: Map<string, number>
  /** Per month: whether a live unreversed gpu-dep entry exists (posted or draft), and how many were reversed. */
  refs: Map<string, { live: boolean; reversed: number }>
  registerNbv: (date: string) => number
}

async function isFleetVehicle(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<boolean> {
  const { data, error } = await (admin as any).from('fund_vehicles').select('kind').eq('fund_id', fundId).eq('id', vehicleId)
  if (error) throw error
  return isGpuSpv(((data as any[]) ?? [])[0]?.kind)
}

/** Every booked, in-service asset of the vehicle with its depreciation state. */
async function loadAssetStates(admin: SupabaseClient, ctx: Lifecycle): Promise<AssetState[]> {
  const out: AssetState[] = []
  for (const asset of await listAssets(admin, ctx.fundId, ctx.vehicleId)) {
    if (!asset.purchase_entry_id || !asset.in_service_date) continue
    const costCode = assetAccountCode(COST_BASE, asset.id)
    const accCode = assetAccountCode(ACCUMULATED_BASE, asset.id)
    const ids = await accountIdsByCode(admin, ctx.fundId, ctx.vehicleId, [costCode, accCode])
    const [capex, posted, refs] = await Promise.all([
      loadCapexEvents(admin, ctx, asset.id, ids.get(costCode)!),
      loadPostedDepreciation(admin, ctx, asset.id, ids.get(accCode)!),
      depreciationRefs(admin, ctx, asset.id),
    ])
    const dep = depreciableFromAsset(asset, capex, posted)!
    out.push({
      asset, accumulatedAccountId: ids.get(accCode)!, schedule: depreciationSchedule(dep), posted, refs,
      registerNbv: date => (asset.disposed_on && asset.disposed_on <= date ? 0 : nbvAsOf(dep, date)),
    })
  }
  return out
}

/** Every live gpu-dep entry for the asset, by month: unreversed (posted or draft), or reversed. */
async function depreciationRefs(admin: SupabaseClient, ctx: Lifecycle, assetId: string): Promise<Map<string, { live: boolean; reversed: number }>> {
  const prefix = `gpu-dep:${assetId}:`
  const { data, error } = await (admin as any).from('journal_entries').select('id, source_ref')
    .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).neq('status', 'void')
    .like('source_ref', `${prefix}%`).order('id')
  if (error) throw error
  const rows: { id: string; source_ref: string }[] = (data as any[]) ?? []
  const out = new Map<string, { live: boolean; reversed: number }>()
  if (!rows.length) return out
  const { data: rev, error: revError } = await (admin as any).from('journal_entries').select('source_ref')
    .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('status', 'posted')
    .in('source_ref', rows.map(r => reversalRef(r.id))).order('id')
  if (revError) throw revError
  const reversed = new Set(((rev as any[]) ?? []).map(r => String(r.source_ref).slice('reversal:'.length)))
  for (const r of rows) {
    const month = r.source_ref.slice(prefix.length, prefix.length + 7)
    const m = out.get(month) ?? { live: false, reversed: 0 }
    if (reversed.has(r.id)) m.reversed++
    else m.live = true
    out.set(month, m)
  }
  return out
}

/**
 * The depreciation the close proposes for [start, end], basis 'fleet': one entry per booked asset per
 * month due in the span with no live entry, at the remaining-life charge on the posted state, dated
 * min(month end, disposal date). A month booked and then reversed is proposed again under
 * `gpu-dep:<id>:<YYYY-MM>:r<n>`. Empty for any vehicle that is not a GPU SPV.
 */
export async function loadFleetCloseSuggestions(
  admin: SupabaseClient, fundId: string, group: string, vehicleId: string, start: string, end: string,
): Promise<CloseEntrySuggestion[]> {
  if (!(await isFleetVehicle(admin, fundId, vehicleId))) return []
  const ctx: Lifecycle = { fundId, group, vehicleId, userId: null }
  const states = await loadAssetStates(admin, ctx)
  if (!states.length) return []
  const expense = (await accountIdsByCode(admin, fundId, vehicleId, [DEPRECIATION_EXPENSE_CODE])).get(DEPRECIATION_EXPENSE_CODE)!
  const out: CloseEntrySuggestion[] = []
  for (const s of states) {
    for (const line of s.schedule) {
      if (line.month < monthOf(start) || line.month > monthOf(end)) continue
      const refs = s.refs.get(line.month)
      if (refs?.live || line.amount <= 0) continue
      const sourceRef = refs?.reversed ? `${gpuSourceRef.depreciation(s.asset.id, line.month)}:r${refs.reversed}` : gpuSourceRef.depreciation(s.asset.id, line.month)
      const entry = buildDepreciationEntry({
        fundId, assetId: s.asset.id, month: line.month, amount: line.amount, expenseAccountId: expense,
        accumulatedAccountId: s.accumulatedAccountId, entryDate: depreciationEntryDate(line.month, s.asset.disposed_on),
        memo: `Depreciation — ${s.asset.name} — ${line.month}`,
      })
      out.push({
        id: sourceRef, sourceRef, basis: 'fleet', title: `Depreciation — ${s.asset.name}`,
        detail: `${line.month} depreciation for ${s.asset.name}${refs?.reversed ? ' (re-proposed: the earlier entry was reversed)' : ''}.`,
        entryDate: entry.entryDate, memo: entry.memo ?? '', sourceType: entry.sourceType ?? 'partnership_expense', required: true,
        postings: entry.postings, evidence: { assetId: s.asset.id },
      })
    }
  }
  return out
}

/** A close-review check row (the shape persistCloseReview stores). */
export interface FleetReviewCheck {
  key: string
  section: string
  label: string
  status: 'passed' | 'blocked'
  detail: string
  evidence: Record<string, unknown>
}

/**
 * The fleet's close review through `end`, blocking on either check:
 *   - depreciation posted through the period end for every booked, in-service asset (a reversed
 *     month counts as not posted);
 *   - each asset's ledger NBV (1600-<a> − 1650-<a>, posted through `end`) equals the register's
 *     nbvAsOf (0 once disposed).
 * Null for any vehicle that is not a GPU SPV.
 */
export async function fleetCloseReview(
  admin: SupabaseClient, fundId: string, group: string, vehicleId: string, end: string,
): Promise<{ blockers: string[]; checks: FleetReviewCheck[] } | null> {
  if (!(await isFleetVehicle(admin, fundId, vehicleId))) return null
  const ctx: Lifecycle = { fundId, group, vehicleId, userId: null }
  const states = await loadAssetStates(admin, ctx)
  const { accounts, postings } = await loadPostedLedger(admin, fundId, group, end)

  const missing = states.map(s => ({
    asset: s.asset, months: s.schedule.map(l => l.month).filter(m => m <= monthOf(end) && !s.posted.has(m)),
  })).filter(x => x.months.length)
  const nbv = states.map(s => {
    const { cost, accumulated } = assetBalances(accounts, postings, s.asset.id)
    return { asset: s.asset, ledger: Math.round((cost - accumulated) * 100) / 100, register: s.registerNbv(end) }
  })
  const mismatched = nbv.filter(x => Math.abs(x.ledger - x.register) >= 0.005)

  const blockers: string[] = []
  if (missing.length) {
    blockers.push(`Depreciation is not posted through ${end} for ${missing.map(x => `${x.asset.name} (${x.months.join(', ')})`).join('; ')}. Post the proposed depreciation entries first.`)
  }
  if (mismatched.length) {
    blockers.push(`Fleet net book value does not agree with the register for ${mismatched.map(x => `${x.asset.name} (ledger ${x.ledger.toFixed(2)}, register ${x.register.toFixed(2)})`).join('; ')}.`)
  }
  return {
    blockers,
    checks: [
      {
        key: 'fleet_depreciation', section: 'GPU fleet', label: 'Depreciation posted through period end',
        status: missing.length ? 'blocked' : 'passed',
        detail: missing.length ? blockers[0] : `Depreciation is posted through ${end} for all ${states.length} in-service asset${states.length === 1 ? '' : 's'}.`,
        evidence: { missing: missing.map(x => ({ assetId: x.asset.id, months: x.months })) },
      },
      {
        key: 'fleet_nbv', section: 'GPU fleet', label: 'Fleet net book value ties to the register',
        status: mismatched.length ? 'blocked' : 'passed',
        detail: mismatched.length ? blockers[blockers.length - 1] : `Ledger net book value equals the register for every asset (${nbv.reduce((t, x) => t + x.ledger, 0).toFixed(2)} in total).`,
        evidence: { assets: nbv.map(x => ({ assetId: x.asset.id, ledger: x.ledger, register: x.register })) },
      },
    ],
  }
}
