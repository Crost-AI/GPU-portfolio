// Disposing of a GPU server (design §2.6, §2.7): clear its cost and accumulated depreciation from
// what the LEDGER holds on 1600-<a> / 1650-<a> (so a manual correction is honoured), take the
// difference to 4500, and mark the register row disposed. Refused until depreciation is posted for
// every month through the disposal month, and while later postings on the asset are outstanding.

import type { SupabaseClient } from '@supabase/supabase-js'
import { assetAccountCode } from '@/lib/accounting/chart'
import { loadPostedLedger } from '@/lib/accounting/load'
import {
  ACCUMULATED_BASE, CASH_CODE, COST_BASE, accountIdsByCode, adoptable, bookOnce, liveEntryByRef, loadCapexEvents,
  loadPostedDepreciation, otherVehicleError, postedTo, type LiveEntry, type Lifecycle,
} from './assets'
import { depreciableFromAsset, depreciationSchedule } from './depreciation'
import { buildDisposalEntry, gpuSourceRef } from './entries'
import type { GpuAssetRow } from './types'

export const DISPOSAL_GAIN_CODE = '4500'

/** The asset accounts' posted balances as positive magnitudes: cost (debit) and accumulated (credit). */
export function assetBalances(
  accounts: { id: string; code: string }[], postings: { accountId: string; amount: number }[], assetId: string,
): { cost: number; accumulated: number } {
  const id = (base: string) => accounts.find(a => a.code === assetAccountCode(base, assetId))?.id
  const costId = id(COST_BASE)
  const accId = id(ACCUMULATED_BASE)
  let cost = 0
  let acc = 0
  for (const p of postings) {
    if (p.accountId === costId) cost += Math.round(p.amount * 100)
    else if (p.accountId === accId) acc += Math.round(p.amount * 100)
  }
  return { cost: cost / 100, accumulated: acc === 0 ? 0 : -acc / 100 }
}

export async function disposeAsset(
  admin: SupabaseClient,
  ctx: Lifecycle,
  asset: GpuAssetRow,
  p: { disposedOn: string; proceeds: number },
): Promise<{ entryId: string; gain: number; disposedOn: string; proceeds: number } | { error: string; inProgress?: true }> {
  const other = otherVehicleError(ctx, asset)
  if (other) return other
  if (asset.status === 'disposed' || asset.disposal_entry_id) return { error: 'This asset is already disposed of' }
  if (!asset.purchase_entry_id) return { error: 'This asset\u2019s purchase is not booked, so there is nothing to dispose of' }
  if (!(p.proceeds >= 0)) return { error: 'proceeds must be zero or more' }

  const costCode = assetAccountCode(COST_BASE, asset.id)
  const accCode = assetAccountCode(ACCUMULATED_BASE, asset.id)
  const ids = await accountIdsByCode(admin, ctx.fundId, ctx.vehicleId, [CASH_CODE, DISPOSAL_GAIN_CODE, costCode, accCode])
  const recordFrom = (booked: LiveEntry) => markDisposed(admin, ctx, asset, booked, ids.get(CASH_CODE)!, ids.get(DISPOSAL_GAIN_CODE)!)

  // A disposal already booked: an earlier attempt whose register update failed (adopt it, with ITS
  // date, proceeds and gain, never this request's, and never rebuilt from the already-cleared
  // accounts), one still in flight (refuse; nothing changes), or one reversed since (refuse).
  const existing = await liveEntryByRef(admin, ctx, gpuSourceRef.disposal(asset.id))
  if (existing) {
    const ok = await adoptable(admin, ctx, gpuSourceRef.disposal(asset.id), existing, 'realized_gain')
    return 'ok' in ok ? recordFrom(existing) : ok
  }

  // Depreciation must be on the books for every month through the disposal month, or the gain is
  // overstated and that month's charge would later land on a cleared asset.
  const posted = await loadPostedDepreciation(admin, ctx, asset.id, ids.get(accCode)!)
  const dep = depreciableFromAsset({ ...asset, disposed_on: p.disposedOn }, await loadCapexEvents(admin, ctx, asset.id, ids.get(costCode)!), posted)
  const missing = (dep ? depreciationSchedule(dep) : []).map(l => l.month).filter(m => !posted.has(m))
  if (missing.length) return { error: `Post depreciation for ${missing.join(', ')} before disposing of this asset.` }

  // Fail closed on a backdated disposal: anything on the asset's accounts dated after the disposal
  // date that does not net to zero (a later month's depreciation or capex) must be voided or
  // reversed first, or this entry would clear it on a date before it happened. A posting and its
  // reversal, both later, net to zero and do not block.
  const { accounts, postings } = await loadPostedLedger(admin, ctx.fundId, ctx.group)
  const later = assetBalances(accounts, postings.filter(x => (x.entryDate ?? '') > p.disposedOn), asset.id)
  if (later.cost !== 0 || later.accumulated !== 0) {
    return { error: `This asset has postings dated after ${p.disposedOn}. Void or reverse them, then dispose of it.` }
  }
  const { cost, accumulated } = assetBalances(accounts, postings.filter(x => (x.entryDate ?? '') <= p.disposedOn), asset.id)
  const { entry } = buildDisposalEntry(
    { fundId: ctx.fundId, entryDate: p.disposedOn, memo: `Disposal \u2014 ${asset.name}` },
    {
      assetId: asset.id, proceeds: p.proceeds, cost, accumulated,
      cashAccountId: ids.get(CASH_CODE)!, gainAccountId: ids.get(DISPOSAL_GAIN_CODE)!,
      costAccountId: ids.get(costCode)!, accumulatedAccountId: ids.get(accCode)!,
    },
  )
  // bookOnce adopts a concurrent winner's POSTED entry (recorded from its own postings) or reports
  // a draft in flight.
  const result = await bookOnce(admin, ctx, entry)
  if ('error' in result) return result
  return recordFrom(result.booked)
}

/** Mark the asset disposed from the committed entry: its date, its cash debit and its 4500 line. */
async function markDisposed(
  admin: SupabaseClient, ctx: Lifecycle, asset: GpuAssetRow, booked: LiveEntry, cashAccountId: string, gainAccountId: string,
): Promise<{ entryId: string; gain: number; disposedOn: string; proceeds: number } | { error: string }> {
  const proceeds = postedTo(booked, cashAccountId)
  const gain = -postedTo(booked, gainAccountId) || 0
  const { data, error } = await (admin as any).from('gpu_assets').update({
    status: 'disposed', disposed_on: booked.entry_date, disposal_proceeds: proceeds,
    disposal_entry_id: booked.id, updated_at: new Date().toISOString(),
  }).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('id', asset.id).select('id')
  if (error) throw error
  // Never a success with a booked disposal and no register row to show it: say so, by entry.
  if (!((data as any[]) ?? []).length) {
    return { error: `The disposal is booked as entry ${booked.id}, but the asset is no longer in the register. Void entry ${booked.id}, or restore the asset and dispose of it again to link it.` }
  }
  return { entryId: booked.id, gain, disposedOn: booked.entry_date, proceeds }
}
