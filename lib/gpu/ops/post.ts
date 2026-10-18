// Post staged GPU operations rows to the ledger: one entry per row (one server, one period).
//
// The caller has checked `fleet` write AND `accounting` write: this books revenue.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { reversalOf } from '@/lib/accounting/reversal'
import { accountIdsByCode, bookOnce, type Lifecycle } from '../assets'
import { buildEarningsEntry } from './entries'
import { fleetVehicleId } from './import'
import { FEE_CODE, RECEIVABLE_CODE, REVENUE_CODE, type EarningRow } from './types'

export interface NeedsReversal {
  id: string
  supersedesId: string
  entryId: string | null
  entryDate: string | null
}

export type PostResult =
  | { posted: { id: string; entryId: string }[]; reversed: { id: string; reversalId: string }[] }
  | { needsReversal: NeedsReversal[] }
  | { error: string; posted?: { id: string; entryId: string }[] }

async function loadRows(admin: SupabaseClient, fundId: string, vehicleId: string, ids: string[]): Promise<EarningRow[]> {
  const { data, error } = await (admin as any).from('gpu_earnings').select('*')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).in('id', ids).order('id')
  if (error) throw error
  return (data as EarningRow[]) ?? []
}

/** The posted entry a superseded row booked, with its postings, for reversalOf. */
async function originalEntry(admin: SupabaseClient, fundId: string, vehicleId: string, entryId: string) {
  const { data, error } = await (admin as any).from('journal_entries')
    .select('id, entry_date, memo, source_type, reference, status, journal_postings(account_id, amount, currency, lp_entity_id)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('id', entryId).maybeSingle()
  if (error) throw error
  return data as any
}

/**
 * Post staged rows. Unmatched, ignored and already-posted rows are refused (nothing is posted).
 *
 * A row that supersedes a posted one (a corrected figure for a server and period already on the
 * books) needs the old entry reversed first. Without `confirmReversal` nothing is posted and the
 * answer lists them (`needsReversal`); with it, each correction books `reversalOf(old entry)` on the
 * period end, marks the old row `reversed`, then posts the new entry. A retry adopts whatever an
 * earlier attempt already booked (bookOnce), so it never books a reversal or a revenue entry twice.
 *
 * A period end inside a closed period is refused by persistEntry's period lock.
 */
export async function postEarnings(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null, ids: string[],
  opts: { confirmReversal?: boolean } = {},
): Promise<PostResult> {
  const vehicle = await fleetVehicleId(admin, fundId, group)
  if ('error' in vehicle) return vehicle
  const ctx: Lifecycle = { fundId, group, vehicleId: vehicle.vehicleId, userId }
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return { error: 'Choose at least one row to post' }

  const rows = await loadRows(admin, fundId, ctx.vehicleId, unique)
  if (rows.length !== unique.length) return { error: 'Some of those rows are not this entity’s' }
  const notStaged = rows.filter(r => r.status !== 'staged')
  if (notStaged.length) {
    return { error: `Only staged rows can be posted: ${notStaged.map(r => `${r.asset_ref} ${r.period_start}..${r.period_end} is ${r.status}`).join('; ')}` }
  }

  const supersededIds = rows.map(r => r.supersedes_id).filter((v): v is string => !!v)
  const superseded = new Map((supersededIds.length ? await loadRows(admin, fundId, ctx.vehicleId, supersededIds) : []).map(r => [r.id, r]))
  const pending = rows.filter(r => r.supersedes_id && superseded.get(r.supersedes_id)?.status === 'posted')
  if (pending.length && !opts.confirmReversal) {
    const entryIds = pending.map(r => superseded.get(r.supersedes_id!)!.journal_entry_id).filter((v): v is string => !!v)
    const { data: entries, error } = entryIds.length
      ? await (admin as any).from('journal_entries').select('id, entry_date').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', entryIds)
      : { data: [], error: null }
    if (error) throw error
    const dateOf = new Map(((entries as any[]) ?? []).map(e => [e.id, e.entry_date as string]))
    return {
      needsReversal: pending.map(r => {
        const old = superseded.get(r.supersedes_id!)!
        return { id: r.id, supersedesId: old.id, entryId: old.journal_entry_id, entryDate: old.journal_entry_id ? dateOf.get(old.journal_entry_id) ?? null : null }
      }),
    }
  }

  const accounts = await accountIdsByCode(admin, fundId, ctx.vehicleId, [RECEIVABLE_CODE, FEE_CODE, REVENUE_CODE])
  const assetIds = Array.from(new Set(rows.map(r => r.asset_id).filter((v): v is string => !!v)))
  const { data: assetRows, error: assetError } = await (admin as any).from('gpu_assets').select('id, name')
    .eq('fund_id', fundId).eq('vehicle_id', ctx.vehicleId).in('id', assetIds)
  if (assetError) throw assetError
  const nameOf = new Map(((assetRows as any[]) ?? []).map(a => [a.id, a.name as string]))

  const posted: { id: string; entryId: string }[] = []
  const reversed: { id: string; reversalId: string }[] = []
  const now = () => new Date().toISOString()
  const fail = (error: string): PostResult => ({ error, posted })

  for (const row of rows) {
    if (!row.asset_id) return fail(`${row.asset_ref} matches no server`)
    const old = row.supersedes_id ? superseded.get(row.supersedes_id) : undefined
    if (old?.status === 'posted') {
      if (!old.journal_entry_id) return fail(`The posted row ${old.id} has no entry to reverse`)
      const original = await originalEntry(admin, fundId, ctx.vehicleId, old.journal_entry_id)
      if (!original || original.status !== 'posted') return fail(`Entry ${old.journal_entry_id} is not posted, so it cannot be reversed`)
      const reversal = reversalOf({
        id: original.id, fundId, entryDate: original.entry_date, memo: original.memo, sourceType: original.source_type, reference: original.reference,
        postings: ((original.journal_postings as any[]) ?? []).map(p => ({ accountId: p.account_id, amount: Number(p.amount), currency: p.currency ?? 'USD', lpEntityId: p.lp_entity_id ?? null })),
      }, row.period_end > original.entry_date ? row.period_end : original.entry_date)
      const booked = await bookOnce(admin, ctx, reversal)
      if ('error' in booked) return fail(booked.error)
      // The journal's own reverse action sets this link; without it a second reverse is allowed.
      await (admin as any).from('journal_entries').update({ reversed_by: booked.booked.id })
        .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('id', original.id)
      const { error } = await (admin as any).from('gpu_earnings').update({ status: 'reversed', updated_at: now() })
        .eq('fund_id', fundId).eq('vehicle_id', ctx.vehicleId).eq('id', old.id).eq('status', 'posted')
      if (error) return fail(error.message)
      reversed.push({ id: old.id, reversalId: booked.booked.id })
    }

    const entry = buildEarningsEntry({
      fundId, earningId: row.id, assetName: nameOf.get(row.asset_id) ?? row.asset_ref,
      periodStart: row.period_start, periodEnd: row.period_end,
      gross: Number(row.gross), fee: Number(row.marketplace_fee), net: Number(row.net),
      receivableAccountId: accounts.get(RECEIVABLE_CODE)!, feeAccountId: accounts.get(FEE_CODE)!, revenueAccountId: accounts.get(REVENUE_CODE)!,
    })
    const booked = await bookOnce(admin, ctx, entry)
    if ('error' in booked) return fail(booked.error)
    const { error } = await (admin as any).from('gpu_earnings').update({ status: 'posted', journal_entry_id: booked.booked.id, updated_at: now() })
      .eq('fund_id', fundId).eq('vehicle_id', ctx.vehicleId).eq('id', row.id).eq('status', 'staged')
    if (error) return fail(error.message)
    posted.push({ id: row.id, entryId: booked.booked.id })
  }
  return { posted, reversed }
}

/** Set aside staged or unmatched rows (a typo, a server that is not ours). Returns the rows changed. */
export async function ignoreEarnings(admin: SupabaseClient, fundId: string, group: string, ids: string[]): Promise<{ ignored: string[] } | { error: string }> {
  const vehicle = await fleetVehicleId(admin, fundId, group)
  if ('error' in vehicle) return vehicle
  if (!ids.length) return { error: 'Choose at least one row to ignore' }
  const { data, error } = await (admin as any).from('gpu_earnings').update({ status: 'ignored', updated_at: new Date().toISOString() })
    .eq('fund_id', fundId).eq('vehicle_id', vehicle.vehicleId).in('id', ids).in('status', ['staged', 'unmatched']).select('id')
  if (error) throw error
  return { ignored: ((data as any[]) ?? []).map(r => r.id) }
}
