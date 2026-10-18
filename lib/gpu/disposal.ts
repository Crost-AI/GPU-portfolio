// Disposing of a GPU server (design §2.6, §2.7): clear its cost and accumulated depreciation from
// what the LEDGER holds on 1600-<a> / 1650-<a> (so a manual correction is honoured), take the
// difference to 4500, and mark the register row disposed. Refused until depreciation is posted for
// every month through the disposal month, and while later postings on the asset are outstanding.

import type { SupabaseClient } from '@supabase/supabase-js'
import { assetAccountCode } from '@/lib/accounting/chart'
import { loadPostedLedger } from '@/lib/accounting/load'
import { persistEntry } from '@/lib/accounting/persist'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { reversalRef } from '@/lib/accounting/reversal'
import { ACCUMULATED_BASE, CASH_CODE, COST_BASE, accountIdsByCode, loadCapexEvents, otherVehicleError, type Lifecycle } from './assets'
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
): Promise<{ entryId: string; gain: number } | { error: string }> {
  const other = otherVehicleError(ctx, asset)
  if (other) return other
  if (asset.status === 'disposed' || asset.disposal_entry_id) return { error: 'This asset is already disposed of' }
  if (!asset.purchase_entry_id) return { error: 'This asset\u2019s purchase is not booked, so there is nothing to dispose of' }
  if (!(p.proceeds >= 0)) return { error: 'proceeds must be zero or more' }

  const costCode = assetAccountCode(COST_BASE, asset.id)
  const accCode = assetAccountCode(ACCUMULATED_BASE, asset.id)
  const ids = await accountIdsByCode(admin, ctx.fundId, ctx.vehicleId, [CASH_CODE, DISPOSAL_GAIN_CODE, costCode, accCode])

  // A disposal booked by an earlier attempt whose register update failed: adopt it, never rebuild it
  // (the asset accounts are already cleared, so a rebuilt entry would read the whole proceeds as gain).
  const { data: found, error: findError } = await (admin as any).from('journal_entries').select('id, entry_date, journal_postings(account_id, amount)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId)
    .eq('source_ref', gpuSourceRef.disposal(asset.id)).neq('status', 'void').order('id').limit(1)
  if (findError) throw findError
  const booked = ((found as any[]) ?? [])[0]
  if (booked) {
    const gain = -(booked.journal_postings ?? []).filter((jp: any) => jp.account_id === ids.get(DISPOSAL_GAIN_CODE))
      .reduce((t: number, jp: any) => t + Math.round(Number(jp.amount) * 100), 0) / 100
    return markDisposed(admin, ctx, asset, booked.entry_date, p.proceeds, booked.id, gain)
  }

  // Depreciation must be on the books for every month through the disposal month, or the gain is
  // overstated and that month's charge would later land on a cleared asset.
  const missing = await missingDepreciationMonths(admin, ctx, asset, ids.get(costCode)!, p.disposedOn)
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
  const { entry, gain } = buildDisposalEntry(
    { fundId: ctx.fundId, entryDate: p.disposedOn, memo: `Disposal \u2014 ${asset.name}` },
    {
      assetId: asset.id, proceeds: p.proceeds, cost, accumulated,
      cashAccountId: ids.get(CASH_CODE)!, gainAccountId: ids.get(DISPOSAL_GAIN_CODE)!,
      costAccountId: ids.get(costCode)!, accumulatedAccountId: ids.get(accCode)!,
    },
  )
  const result = await persistEntry(admin, ctx.fundId, ctx.group, ctx.userId, entry, 'posted')
  // A concurrent attempt booked it first: adopt that one, as above.
  const entryId = 'entryId' in result ? result.entryId : result.duplicateOf
  if (!entryId) return { error: (result as { error: string }).error }
  return markDisposed(admin, ctx, asset, p.disposedOn, p.proceeds, entryId, gain)
}

async function markDisposed(
  admin: SupabaseClient, ctx: Lifecycle, asset: GpuAssetRow, disposedOn: string, proceeds: number, entryId: string, gain: number,
): Promise<{ entryId: string; gain: number }> {
  const { error } = await (admin as any).from('gpu_assets').update({
    status: 'disposed', disposed_on: disposedOn, disposal_proceeds: proceeds,
    disposal_entry_id: entryId, updated_at: new Date().toISOString(),
  }).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('id', asset.id)
  if (error) throw error
  return { entryId, gain }
}

/**
 * Schedule months through the disposal month with no live `gpu-dep:<id>:<YYYY-MM>[...]` entry. An
 * original that has been reversed does not count (a corrected month posts under a suffixed ref).
 */
export async function missingDepreciationMonths(
  admin: SupabaseClient, ctx: Lifecycle, asset: GpuAssetRow, costAccountId: string, disposedOn: string,
): Promise<string[]> {
  const dep = depreciableFromAsset({ ...asset, disposed_on: disposedOn }, await loadCapexEvents(admin, ctx, asset.id, costAccountId))
  const due = dep ? depreciationSchedule(dep) : []
  if (!due.length) return []
  const prefix = `gpu-dep:${asset.id}:`
  const { data, error } = await (admin as any).from('journal_entries').select('id, source_ref')
    .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('status', 'posted')
    .like('source_ref', `${prefix}%`).order('id')
  if (error) throw error
  const rows: { id: string; source_ref: string }[] = (data as any[]) ?? []
  let reversed = new Set<string>()
  if (rows.length) {
    const { data: rev, error: revError } = await (admin as any).from('journal_entries').select('source_ref')
      .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('status', 'posted')
      .in('source_ref', rows.map(r => reversalRef(r.id))).order('id')
    if (revError) throw revError
    reversed = new Set(((rev as any[]) ?? []).map(r => String(r.source_ref).slice('reversal:'.length)))
  }
  const posted = new Set(rows.filter(r => !reversed.has(r.id)).map(r => r.source_ref.slice(prefix.length, prefix.length + 7)))
  return due.map(l => l.month).filter(m => !posted.has(m))
}
