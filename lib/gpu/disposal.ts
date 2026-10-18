// Disposing of a GPU server (design §2.6, §2.7): clear its cost and accumulated depreciation from
// what the LEDGER holds on 1600-<a> / 1650-<a> (so a manual correction is honoured), take the
// difference to 4500, and mark the register row disposed. Depreciation through the disposal month
// should be posted first; the close's depreciation check is what enforces that (P1b-2).

import type { SupabaseClient } from '@supabase/supabase-js'
import { assetAccountCode } from '@/lib/accounting/chart'
import { loadPostedLedger } from '@/lib/accounting/load'
import { persistEntry } from '@/lib/accounting/persist'
import { ACCUMULATED_BASE, CASH_CODE, COST_BASE, accountIdsByCode } from './assets'
import { buildDisposalEntry } from './entries'
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
  ctx: { fundId: string; group: string; vehicleId: string; userId: string | null },
  asset: GpuAssetRow,
  p: { disposedOn: string; proceeds: number },
): Promise<{ entryId: string; gain: number } | { error: string }> {
  if (asset.status === 'disposed' || asset.disposal_entry_id) return { error: 'This asset is already disposed of' }
  if (!asset.purchase_entry_id) return { error: 'This asset’s purchase is not booked, so there is nothing to dispose of' }
  if (!(p.proceeds >= 0)) return { error: 'proceeds must be zero or more' }

  const { accounts, postings } = await loadPostedLedger(admin, ctx.fundId, ctx.group)
  const { cost, accumulated } = assetBalances(accounts, postings, asset.id)
  const ids = await accountIdsByCode(admin, ctx.fundId, ctx.vehicleId, [
    CASH_CODE, DISPOSAL_GAIN_CODE, assetAccountCode(COST_BASE, asset.id), assetAccountCode(ACCUMULATED_BASE, asset.id),
  ])
  const { entry, gain } = buildDisposalEntry(
    { fundId: ctx.fundId, entryDate: p.disposedOn, memo: `Disposal — ${asset.name}` },
    {
      assetId: asset.id, proceeds: p.proceeds, cost, accumulated,
      cashAccountId: ids.get(CASH_CODE)!, gainAccountId: ids.get(DISPOSAL_GAIN_CODE)!,
      costAccountId: ids.get(assetAccountCode(COST_BASE, asset.id))!,
      accumulatedAccountId: ids.get(assetAccountCode(ACCUMULATED_BASE, asset.id))!,
    },
  )
  const result = await persistEntry(admin, ctx.fundId, ctx.group, ctx.userId, entry, 'posted')
  if ('error' in result) return { error: result.error }
  const { error } = await (admin as any).from('gpu_assets').update({
    status: 'disposed', disposed_on: p.disposedOn, disposal_proceeds: p.proceeds,
    disposal_entry_id: result.entryId, updated_at: new Date().toISOString(),
  }).eq('fund_id', ctx.fundId).eq('id', asset.id)
  if (error) throw error
  return { entryId: result.entryId, gain }
}
