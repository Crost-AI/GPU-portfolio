// ── GPU fleet (P1) ── The fleet's part of the period close (design §4.5): the monthly depreciation
// the close proposes, and the review checks it blocks on. Only a gpu_spv vehicle has any; every
// other vehicle gets nothing from here, so its close is unchanged.
//
// The vehicle's fleet is read in one pass (fleet-ledger.ts, one query per table), as of the period
// end; the remaining-life schedule (lib/gpu/depreciation.ts) is built on that posted state.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CloseEntrySuggestion } from '@/lib/accounting/close-suggestions'
import { loadPostedLedger } from '@/lib/accounting/load'
import { isGpuSpv } from '@/lib/vehicle-kinds'
import { accountIdsByCode } from './assets'
import { depreciableFromAsset, depreciationEntryDate, depreciationSchedule, nbvAsOf, type DepreciationLine } from './depreciation'
import { assetBalances } from './disposal'
import { buildDepreciationEntry, gpuSourceRef } from './entries'
import { loadFleetLedger } from './fleet-ledger'
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

interface FleetState {
  /** Booked, in-service assets with their depreciation state. */
  assets: AssetState[]
  /** Assets whose purchase is posted but not linked from the register (the claim/recovery window). */
  unlinked: GpuAssetRow[]
  /** Linked assets whose purchase was reversed by the cutoff while depreciation or capex remains. */
  reversed: GpuAssetRow[]
  /** Every per-asset 1600-<a>/1650-<a> account id: only the fleet proposes entries on these. */
  assetAccountIds: Set<string>
}

/**
 * The vehicle's fleet as of `asOf` (fleet-ledger.ts, one pass): the booked, in-service assets with
 * their schedules, and any purchase booked but left unlinked from the register.
 */
async function loadFleetState(admin: SupabaseClient, fundId: string, vehicleId: string, asOf: string): Promise<FleetState> {
  const ledger = await loadFleetLedger(admin, fundId, vehicleId, asOf)
  const state: FleetState = { assets: [], unlinked: [], reversed: [], assetAccountIds: ledger.assetAccountIds }
  for (const l of ledger.assets) {
    if (!l.asset.purchase_entry_id) {
      if (l.purchase) state.unlinked.push(l.asset)
      continue
    }
    // A purchase reversed by `asOf` is not a future purchase: an asset unwound that way must be
    // unwound completely (its depreciation and capex too), or the books hold them for nothing.
    if (l.purchaseReversed) {
      const capexLeft = l.capex.reduce((t, e) => t + Math.round(e.amount * 100), 0) !== 0
      if (l.posted.size || capexLeft) state.reversed.push(l.asset)
      continue
    }
    // Not yet bought as of `asOf` (its purchase is dated later): not part of this period's fleet.
    if (!l.purchase || !l.asset.in_service_date) continue
    if (!l.costAccountId || !l.accumulatedAccountId) throw new Error(`${l.asset.name} has no 1600/1650 accounts though its purchase is booked`)
    const dep = depreciableFromAsset(l.asset, l.capex, l.posted)!
    state.assets.push({
      asset: l.asset, accumulatedAccountId: l.accumulatedAccountId, schedule: depreciationSchedule(dep), posted: l.posted, refs: l.refs,
      registerNbv: date => (l.asset.disposed_on && l.asset.disposed_on <= date ? 0 : nbvAsOf(dep, date)),
    })
  }
  return state
}

/**
 * The depreciation the close proposes for [start, end], basis 'fleet': one entry per booked asset per
 * month due in the span with no live entry, at the remaining-life charge on the posted state, dated
 * min(month end, disposal date). A month booked and then reversed is proposed again under
 * `gpu-dep:<id>:<YYYY-MM>:r<n>`. Also the asset accounts, so the caller can drop any other proposal
 * on them (the fleet is their only source). Null for any vehicle that is not a GPU SPV, and when the
 * vehicle's kind cannot be read (suggestions are advice; the close's own checks fail closed).
 */
export async function loadFleetCloseSuggestions(
  admin: SupabaseClient, fundId: string, vehicleId: string, start: string, end: string,
): Promise<{ suggestions: CloseEntrySuggestion[]; assetAccountIds: Set<string> } | null> {
  try {
    const { data, error } = await (admin as any).from('fund_vehicles').select('kind').eq('fund_id', fundId).eq('id', vehicleId)
    if (error || !isGpuSpv(((data as any[]) ?? [])[0]?.kind)) return null
  } catch (e) {
    console.warn('[fleet-close-suggestions] vehicle kind unread; no fleet suggestions', (e as Error)?.message)
    return null
  }
  const state = await loadFleetState(admin, fundId, vehicleId, end)
  const suggestions: CloseEntrySuggestion[] = []
  if (state.assets.length) {
    const expense = (await accountIdsByCode(admin, fundId, vehicleId, [DEPRECIATION_EXPENSE_CODE])).get(DEPRECIATION_EXPENSE_CODE)!
    for (const s of state.assets) {
      for (const line of s.schedule) {
        // Due when its entry date (min(month end, disposal)) falls in the span: a period ending
        // mid-month does not yet owe that month's charge.
        const date = depreciationEntryDate(line.month, s.asset.disposed_on)
        if (date < start || date > end) continue
        const refs = s.refs.get(line.month)
        if (s.posted.has(line.month) || refs?.live || line.amount <= 0) continue
        const sourceRef = refs?.reversed ? `${gpuSourceRef.depreciation(s.asset.id, line.month)}:r${refs.reversed}` : gpuSourceRef.depreciation(s.asset.id, line.month)
        const entry = buildDepreciationEntry({
          fundId, assetId: s.asset.id, month: line.month, amount: line.amount, expenseAccountId: expense,
          accumulatedAccountId: s.accumulatedAccountId, entryDate: depreciationEntryDate(line.month, s.asset.disposed_on),
          memo: `Depreciation — ${s.asset.name} — ${line.month}`,
        })
        suggestions.push({
          id: sourceRef, sourceRef, basis: 'fleet', title: `Depreciation — ${s.asset.name}`,
          detail: `${line.month} depreciation for ${s.asset.name}${refs?.reversed ? ' (re-proposed: the earlier entry was reversed)' : ''}.`,
          entryDate: entry.entryDate, memo: entry.memo ?? '', sourceType: entry.sourceType ?? 'partnership_expense', required: true,
          postings: entry.postings, evidence: { assetId: s.asset.id },
        })
      }
    }
  }
  return { suggestions, assetAccountIds: state.assetAccountIds }
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
 * The fleet's close review through `end`, for a GPU SPV (`kind`, as the close already read it); null
 * for anything else. Two blocker checks:
 *   - depreciation posted through the period end for every booked, in-service asset (a reversed
 *     month counts as not posted), and no purchase booked but left unlinked from the register;
 *   - each remaining asset's ledger NBV (1600-<a> − 1650-<a>, posted through `end`) equals the
 *     register's nbvAsOf (0 once disposed). An asset already flagged above is not checked twice.
 * A fleet that cannot be read is a blocker, never "nothing to check".
 */
export async function fleetCloseReview(
  admin: SupabaseClient, fundId: string, group: string, vehicleId: string | null, kind: string | null, end: string,
): Promise<{ blockers: string[]; checks: FleetReviewCheck[] } | null> {
  if (!isGpuSpv(kind) || !vehicleId) return null
  let state: FleetState
  let ledger: Awaited<ReturnType<typeof loadPostedLedger>>
  try {
    ;[state, ledger] = await Promise.all([loadFleetState(admin, fundId, vehicleId, end), loadPostedLedger(admin, fundId, group, end)])
  } catch (e) {
    const blocker = `The GPU fleet could not be checked: ${(e as Error).message}. Try again before closing.`
    return { blockers: [blocker], checks: [{ key: 'fleet_depreciation', section: 'GPU fleet', label: 'Depreciation posted through period end', status: 'blocked', detail: blocker, evidence: {} }] }
  }

  const missing = state.assets.map(s => ({
    // Only a month with a positive charge due needs a posting (after a capex reversal, a zero month does not).
    // and only once its entry date (min(month end, disposal)) is on or before the period end.
    asset: s.asset, months: s.schedule.filter(l => depreciationEntryDate(l.month, s.asset.disposed_on) <= end && l.amount > 0 && !s.posted.has(l.month)).map(l => l.month),
  })).filter(x => x.months.length)
  const flagged = new Set([...missing.map(x => x.asset.id), ...state.unlinked.map(a => a.id), ...state.reversed.map(a => a.id)])
  const nbv = state.assets.filter(s => !flagged.has(s.asset.id)).map(s => {
    const { cost, accumulated } = assetBalances(ledger.accounts, ledger.postings, s.asset.id)
    return { asset: s.asset, ledger: Math.round((cost - accumulated) * 100) / 100, register: s.registerNbv(end) }
  })
  const mismatched = nbv.filter(x => Math.abs(x.ledger - x.register) >= 0.005)

  const depreciationProblems = [
    ...missing.map(x => `depreciation is not posted through ${end} for ${x.asset.name} (${x.months.join(', ')})`),
    ...state.unlinked.map(a => `${a.name}'s purchase is booked but not linked to the register; retry the purchase`),
    ...state.reversed.map(a => `${a.name}'s purchase was reversed but its depreciation or capex remains; reverse those too, or book the purchase again`),
  ]
  const blockers: string[] = []
  if (depreciationProblems.length) blockers.push(`GPU fleet: ${depreciationProblems.join('; ')}. Post the proposed depreciation entries (and link any booked purchase) first.`)
  if (mismatched.length) {
    blockers.push(`GPU fleet: net book value does not agree with the register for ${mismatched.map(x => `${x.asset.name} (ledger ${x.ledger.toFixed(2)}, register ${x.register.toFixed(2)})`).join('; ')}.`)
  }
  return {
    blockers,
    checks: [
      {
        key: 'fleet_depreciation', section: 'GPU fleet', label: 'Depreciation posted through period end',
        status: depreciationProblems.length ? 'blocked' : 'passed',
        detail: depreciationProblems.length ? blockers[0] : `Depreciation is posted through ${end} for all ${state.assets.length} in-service asset${state.assets.length === 1 ? '' : 's'}.`,
        evidence: { missing: missing.map(x => ({ assetId: x.asset.id, months: x.months })), unlinked: state.unlinked.map(a => a.id), reversed: state.reversed.map(a => a.id) },
      },
      {
        key: 'fleet_nbv', section: 'GPU fleet', label: 'Fleet net book value ties to the register',
        status: mismatched.length ? 'blocked' : 'passed',
        detail: mismatched.length ? blockers[blockers.length - 1] : `Ledger net book value equals the register for every asset checked (${nbv.reduce((t, x) => t + x.ledger, 0).toFixed(2)} in total).`,
        evidence: { assets: nbv.map(x => ({ assetId: x.asset.id, ledger: x.ledger, register: x.register })) },
      },
    ],
  }
}
