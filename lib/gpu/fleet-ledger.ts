// ── GPU fleet (P1) ── A vehicle's fleet as the LEDGER holds it, read in one pass (one query per
// table): the per-asset 1600/1650 accounts, every live `gpu-*` journal entry with its postings, and
// the posted reversals of them. Shared by the close (close-checks.ts) and the register valuation
// (valuation.ts), so neither reads per asset.
//
// Everything that is ledger state (the purchase, capex, posted depreciation, and the reversals that
// undo them) counts only entries dated on or before `asOf`, so a later entry never changes an earlier
// answer. The all-time gpu-dep refs are kept apart, only to number a re-proposal and avoid colliding
// with an entry already there.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { assetAccountCode } from '@/lib/accounting/chart'
import { fetchAllRows, fetchAllRowsIn } from '@/lib/accounting/load'
import { reversalRef } from '@/lib/accounting/reversal'
import { ACCUMULATED_BASE, COST_BASE } from './assets'
import type { CapexEvent } from './depreciation'
import { gpuSourceRef } from './entries'
import type { GpuAssetRow } from './types'

export interface LedgerCapexEvent extends CapexEvent {
  /** The capex entry, or `reversal:<id>` for the reversal that takes it back. */
  source_ref: string
  posted_at: string | null
}

export interface AssetLedger {
  asset: GpuAssetRow
  costAccountId: string | null
  accumulatedAccountId: string | null
  /** The posted, unreversed purchase dated on or before `asOf`, or null. */
  purchase: { id: string; entry_date: string } | null
  /** Capex (and reversals of it) dated on or before `asOf`, in date order. */
  capex: LedgerCapexEvent[]
  /** Depreciation posted and unreversed as of `asOf`, by month. */
  posted: Map<string, number>
  /** All time, per month: a live unreversed gpu-dep entry (posted or draft), and how many were reversed. */
  refs: Map<string, { live: boolean; reversed: number }>
}

const cents = (n: unknown) => Math.round(Number(n) * 100)

export async function loadFleetLedger(
  admin: SupabaseClient, fundId: string, vehicleId: string, asOf: string, rows?: GpuAssetRow[],
): Promise<{ assets: AssetLedger[]; assetAccountIds: Set<string> }> {
  const scoped = (q: any) => q.eq('fund_id', fundId).eq('vehicle_id', vehicleId)
  const [assets, chart, entries] = await Promise.all([
    rows ?? fetchAllRows<GpuAssetRow>((f, t) => scoped((admin as any).from('gpu_assets').select('*')).order('created_at').range(f, t)),
    fetchAllRows<{ id: string; code: string }>((f, t) => scoped((admin as any).from('chart_of_accounts').select('id, code')).like('code', '16%').range(f, t)),
    fetchAllRows<any>((f, t) => scoped((admin as any).from('journal_entries').select('id, status, entry_date, posted_at, source_ref, journal_postings(account_id, amount)'))
      .eq('book', ACTUAL_BOOK).neq('status', 'void').like('source_ref', 'gpu-%').range(f, t)),
  ])
  const reversals = entries.length
    ? await fetchAllRowsIn<any>(entries.map(e => reversalRef(e.id)), (chunk, f, t) => scoped((admin as any).from('journal_entries')
      .select('id, entry_date, posted_at, source_ref, journal_postings(account_id, amount)')).eq('book', ACTUAL_BOOK).eq('status', 'posted').in('source_ref', chunk).range(f, t))
    : []
  const reversalOf = new Map<string, any>(reversals.map(r => [String(r.source_ref).slice('reversal:'.length), r]))
  const reversedAsOf = (e: any) => { const r = reversalOf.get(e.id); return !!r && String(r.entry_date) <= asOf }
  const inPeriod = (e: any) => String(e.entry_date) <= asOf
  const accountId = new Map(chart.map(a => [a.code, a.id]))
  const to = (e: any, account: string | null) =>
    (e.journal_postings ?? []).filter((p: any) => p.account_id === account).reduce((t: number, p: any) => t + cents(p.amount), 0)

  const out: AssetLedger[] = []
  for (const asset of assets) {
    const mine = (prefix: string) => entries.filter(e => String(e.source_ref).startsWith(prefix))
    const costAccountId = accountId.get(assetAccountCode(COST_BASE, asset.id)) ?? null
    const accumulatedAccountId = accountId.get(assetAccountCode(ACCUMULATED_BASE, asset.id)) ?? null
    const purchase = mine(gpuSourceRef.purchase(asset.id)).find(e => e.status === 'posted' && inPeriod(e) && !reversedAsOf(e)) ?? null

    const capex: LedgerCapexEvent[] = []
    for (const e of mine(`gpu-asset:${asset.id}:capex:`).filter(e => e.status === 'posted' && inPeriod(e))) {
      capex.push({ month: String(e.entry_date).slice(0, 7), amount: to(e, costAccountId) / 100, source_ref: e.source_ref, posted_at: e.posted_at ?? null })
      if (reversedAsOf(e)) {
        const r = reversalOf.get(e.id)
        capex.push({ month: String(r.entry_date).slice(0, 7), amount: to(r, costAccountId) / 100, source_ref: r.source_ref, posted_at: r.posted_at ?? null })
      }
    }
    capex.sort((x, y) => (x.month < y.month ? -1 : x.month > y.month ? 1 : 0))

    const posted = new Map<string, number>()
    const refs = new Map<string, { live: boolean; reversed: number }>()
    const depPrefix = `gpu-dep:${asset.id}:`
    for (const e of mine(depPrefix)) {
      const month = String(e.source_ref).slice(depPrefix.length, depPrefix.length + 7)
      const ref = refs.get(month) ?? { live: false, reversed: 0 }
      if (reversalOf.has(e.id)) ref.reversed++
      else ref.live = true
      refs.set(month, ref)
      if (e.status === 'posted' && inPeriod(e) && !reversedAsOf(e)) posted.set(month, (cents(posted.get(month) ?? 0) - to(e, accumulatedAccountId)) / 100)
    }
    out.push({ asset, costAccountId, accumulatedAccountId, purchase: purchase && { id: purchase.id, entry_date: purchase.entry_date }, capex: capex.filter(c => c.amount !== 0), posted, refs })
  }
  const assetAccountIds = new Set(chart.filter(a => /^16[05]0-/.test(a.code)).map(a => a.id))
  return { assets: out, assetAccountIds }
}
