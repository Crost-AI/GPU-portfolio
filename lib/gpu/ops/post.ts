// Post staged GPU operations rows to the ledger: one entry per row (one server, one period).
//
// The caller has checked `fleet` write AND `accounting` write: this books revenue.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { fetchAllRowsIn, IN_CHUNK } from '@/lib/accounting/load'
import { reversalOf, reversalRef } from '@/lib/accounting/reversal'
import { accountIdsByCode, bookOnce, liveEntryByRef, postedTo, type Lifecycle } from '../assets'
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
  | { posted: { id: string; entryId: string | null }[]; reversed: { id: string; reversalId: string | null }[] }
  | { needsReversal: NeedsReversal[] }
  | { error: string; posted?: { id: string; entryId: string | null }[] }

const cents = (n: number) => Math.round(Number(n) * 100)
/** gross = fee = net = 0: a period with nothing to book (an idle or offline server). */
export const isZeroPeriod = (r: Pick<EarningRow, 'gross' | 'marketplace_fee' | 'net'>) =>
  cents(r.gross) === 0 && cents(r.marketplace_fee) === 0 && cents(r.net) === 0

async function loadRows(admin: SupabaseClient, fundId: string, vehicleId: string, ids: string[]): Promise<EarningRow[]> {
  return fetchAllRowsIn<EarningRow>(ids, (chunk, f, t) => (admin as any).from('gpu_earnings').select('*')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).in('id', chunk).range(f, t))
}

/** The posted entry a superseded row booked, with its postings, for reversalOf. */
async function originalEntry(admin: SupabaseClient, fundId: string, vehicleId: string, entryId: string) {
  const { data, error } = await (admin as any).from('journal_entries')
    .select('id, entry_date, memo, source_type, reference, status, journal_postings(account_id, amount, currency, lp_entity_id)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('id', entryId).maybeSingle()
  if (error) throw error
  return data as any
}

/** Flip a row's status from `from` to `to` only if it still is `from`; true when this request won. */
async function claim(admin: SupabaseClient, ctx: Lifecycle, id: string, from: string, to: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  const { data, error } = await (admin as any).from('gpu_earnings').update({ status: to, updated_at: new Date().toISOString(), ...extra })
    .eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('id', id).eq('status', from).select('id')
  if (error) throw error
  return ((data as any[]) ?? []).length > 0
}

const busy = (r: Pick<EarningRow, 'asset_ref' | 'period_start' | 'period_end'>) =>
  `${r.asset_ref} ${r.period_start}..${r.period_end} is being posted by another request. Try again shortly.`

/**
 * Post staged rows. Unmatched, ignored and posted rows are refused (nothing is posted). A row left
 * 'posting' by a failed attempt is resumed: its figures were frozen by the claim, and the ledger's
 * once-only index keeps its entry single.
 *
 * Each row is CLAIMED first (staged → posting, conditionally), so a second request cannot post it
 * and an import cannot change its figures while the entry is built. An entry already under the
 * row's ref (an earlier attempt) is adopted only when its 1150/5150/4000 amounts equal the row's.
 *
 * A row that supersedes a posted one needs the old entry reversed first. Without `confirmReversal`
 * nothing is posted and the answer lists them (`needsReversal`); with it, the old row is claimed
 * (posted → reversing) so exactly one request books `reversalOf(old entry)`, then marked reversed.
 *
 * A zero period (gross = fee = net = 0) books nothing: the row is marked posted with no entry, after
 * the reversal when it corrects a period that had revenue. A period end inside a closed period is
 * refused by persistEntry's period lock and the row goes back to staged.
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
  const notStaged = rows.filter(r => r.status !== 'staged' && r.status !== 'posting')
  if (notStaged.length) {
    return { error: `Only staged rows can be posted: ${notStaged.map(r => `${r.asset_ref} ${r.period_start}..${r.period_end} is ${r.status}`).join('; ')}` }
  }
  const noServer = rows.find(r => !r.asset_id)
  if (noServer) return { error: `${noServer.asset_ref} matches no server` }

  const supersededIds = rows.map(r => r.supersedes_id).filter((v): v is string => !!v)
  const superseded = new Map((supersededIds.length ? await loadRows(admin, fundId, ctx.vehicleId, supersededIds) : []).map(r => [r.id, r]))
  const pending = rows.filter(r => r.supersedes_id && superseded.get(r.supersedes_id)?.status === 'posted')
  if (pending.length && !opts.confirmReversal) {
    const entryIds = pending.map(r => superseded.get(r.supersedes_id!)!.journal_entry_id).filter((v): v is string => !!v)
    const entries = await fetchAllRowsIn<{ id: string; entry_date: string }>(entryIds, (chunk, f, t) => (admin as any).from('journal_entries')
      .select('id, entry_date').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).in('id', chunk).range(f, t))
    const dateOf = new Map(entries.map(e => [e.id, e.entry_date]))
    return {
      needsReversal: pending.map(r => {
        const old = superseded.get(r.supersedes_id!)!
        return { id: r.id, supersedesId: old.id, entryId: old.journal_entry_id, entryDate: old.journal_entry_id ? dateOf.get(old.journal_entry_id) ?? null : null }
      }),
    }
  }

  const accounts = await accountIdsByCode(admin, fundId, ctx.vehicleId, [RECEIVABLE_CODE, FEE_CODE, REVENUE_CODE])
  const assetIds = Array.from(new Set(rows.map(r => r.asset_id!)))
  const assetRows = await fetchAllRowsIn<{ id: string; name: string }>(assetIds, (chunk, f, t) => (admin as any).from('gpu_assets').select('id, name')
    .eq('fund_id', fundId).eq('vehicle_id', ctx.vehicleId).in('id', chunk).range(f, t))
  const nameOf = new Map(assetRows.map(a => [a.id, a.name]))

  const posted: { id: string; entryId: string | null }[] = []
  const reversed: { id: string; reversalId: string | null }[] = []
  const fail = (error: string): PostResult => ({ error, posted })

  for (const listed of rows) {
    // Claim the row. A row already 'posting' is a failed attempt being resumed.
    if (listed.status === 'staged' && !(await claim(admin, ctx, listed.id, 'staged', 'posting'))) return fail(busy(listed))
    const [row] = await loadRows(admin, fundId, ctx.vehicleId, [listed.id])
    if (!row || row.status !== 'posting') return fail(busy(listed))
    const release = async (error: string) => { await claim(admin, ctx, row.id, 'posting', 'staged'); return fail(error) }

    const old = row.supersedes_id ? superseded.get(row.supersedes_id) : undefined
    if (old && (old.status === 'posted' || old.status === 'reversing')) {
      const done = await reverseSuperseded(admin, ctx, old)
      if ('error' in done) return release(done.error)
      reversed.push({ id: old.id, reversalId: done.reversalId })
    }

    let entryId: string | null = null
    if (!isZeroPeriod(row)) {
      const entry = buildEarningsEntry({
        fundId, earningId: row.id, assetName: nameOf.get(row.asset_id!) ?? row.asset_ref,
        periodStart: row.period_start, periodEnd: row.period_end,
        gross: Number(row.gross), fee: Number(row.marketplace_fee), net: Number(row.net),
        receivableAccountId: accounts.get(RECEIVABLE_CODE)!, feeAccountId: accounts.get(FEE_CODE)!, revenueAccountId: accounts.get(REVENUE_CODE)!,
      })
      const booked = await bookOnce(admin, ctx, entry)
      if ('error' in booked) return release(booked.error)
      if (booked.adopted) {
        const got = { net: postedTo(booked.booked, accounts.get(RECEIVABLE_CODE)!), fee: postedTo(booked.booked, accounts.get(FEE_CODE)!), gross: -postedTo(booked.booked, accounts.get(REVENUE_CODE)!) }
        const want = { net: Number(row.net), fee: Number(row.marketplace_fee), gross: Number(row.gross) }
        const off = (['gross', 'fee', 'net'] as const).filter(k => cents(got[k]) !== cents(want[k]))
        if (off.length) {
          return release(`Entry ${booked.booked.id} already booked for this row carries ${off.map(k => `${k} ${got[k]}`).join(', ')}, but the row says ${off.map(k => `${k} ${want[k]}`).join(', ')}. Void that entry, then post again.`)
        }
      }
      entryId = booked.booked.id
    }
    if (!(await claim(admin, ctx, row.id, 'posting', 'posted', { journal_entry_id: entryId }))) return fail(busy(row))
    posted.push({ id: row.id, entryId })
  }
  return { posted, reversed }
}

/**
 * Reverse the entry a superseded row booked, once. The row is claimed (posted → reversing) so a
 * concurrent post of the same correction cannot book a second contra-entry; a row already
 * 'reversing' is finished only when its reversal is on the books, else it is another request's.
 */
async function reverseSuperseded(
  admin: SupabaseClient, ctx: Lifecycle, old: EarningRow,
): Promise<{ reversalId: string | null } | { error: string }> {
  if (old.status === 'posted' && !(await claim(admin, ctx, old.id, 'posted', 'reversing'))) {
    return { error: `The posted entry for ${old.asset_ref} ${old.period_start}..${old.period_end} is being reversed by another request. Try again shortly.` }
  }
  const undo = async (error: string) => { if (old.status === 'posted') await claim(admin, ctx, old.id, 'reversing', 'posted'); return { error } }

  // A zero period booked nothing, so there is nothing to reverse.
  if (!old.journal_entry_id) {
    return (await claim(admin, ctx, old.id, 'reversing', 'reversed')) ? { reversalId: null } : { error: `Could not mark ${old.id} reversed` }
  }
  if (old.status === 'reversing') {
    // Left by an earlier attempt, or held by a concurrent one: finish only what is already booked.
    const prior = await liveEntryByRef(admin, ctx, reversalRef(old.journal_entry_id))
    if (!prior || prior.status !== 'posted') {
      return { error: `The posted entry for ${old.asset_ref} ${old.period_start}..${old.period_end} is being reversed by another request. Try again shortly.` }
    }
    await claim(admin, ctx, old.id, 'reversing', 'reversed')
    return { reversalId: prior.id }
  }

  const original = await originalEntry(admin, ctx.fundId, ctx.vehicleId, old.journal_entry_id)
  if (!original || original.status !== 'posted') return undo(`Entry ${old.journal_entry_id} is not posted, so it cannot be reversed`)
  const reversal = reversalOf({
    id: original.id, fundId: ctx.fundId, entryDate: original.entry_date, memo: original.memo, sourceType: original.source_type, reference: original.reference,
    postings: ((original.journal_postings as any[]) ?? []).map(p => ({ accountId: p.account_id, amount: Number(p.amount), currency: p.currency ?? 'USD', lpEntityId: p.lp_entity_id ?? null })),
  }, old.period_end > original.entry_date ? old.period_end : original.entry_date)
  const booked = await bookOnce(admin, ctx, reversal)
  if ('error' in booked) return undo(booked.error)
  // The journal's own reverse action sets this link; without it a second reverse is allowed.
  await (admin as any).from('journal_entries').update({ reversed_by: booked.booked.id })
    .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('id', original.id)
  if (!(await claim(admin, ctx, old.id, 'reversing', 'reversed'))) return { error: `Could not mark ${old.id} reversed` }
  return { reversalId: booked.booked.id }
}

/** Set aside staged or unmatched rows (a typo, a server that is not ours). Returns the rows changed. */
export async function ignoreEarnings(admin: SupabaseClient, fundId: string, group: string, ids: string[]): Promise<{ ignored: string[] } | { error: string }> {
  const vehicle = await fleetVehicleId(admin, fundId, group)
  if ('error' in vehicle) return vehicle
  if (!ids.length) return { error: 'Choose at least one row to ignore' }
  const unique = Array.from(new Set(ids))
  const ignored: string[] = []
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const { data, error } = await (admin as any).from('gpu_earnings').update({ status: 'ignored', updated_at: new Date().toISOString() })
      .eq('fund_id', fundId).eq('vehicle_id', vehicle.vehicleId).in('id', unique.slice(i, i + IN_CHUNK)).in('status', ['staged', 'unmatched']).select('id')
    if (error) throw error
    ignored.push(...((data as any[]) ?? []).map(r => r.id))
  }
  return { ignored }
}
