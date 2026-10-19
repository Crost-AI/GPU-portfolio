// Post staged GPU operations rows to the ledger: one entry per row (one server, one period).
//
// The caller has checked `fleet` write AND `accounting` write: this books revenue.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { fetchAllRowsIn, IN_CHUNK } from '@/lib/accounting/load'
import { reversalOf, reversalRef } from '@/lib/accounting/reversal'
import { accountIdsByCode, bookOnce, liveEntryByRef, postedTo, type Lifecycle, type LiveEntry } from '../assets'
import { completeFromEvidence, settleClaim, takeClaim, takeOver } from './claims'
import { buildEarningsEntry } from './entries'
import { fleetVehicleId } from './import'
import { FEE_CODE, RECEIVABLE_CODE, REVENUE_CODE, opsSourceRef, type EarningRow } from './types'

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

const busy = (r: Pick<EarningRow, 'asset_ref' | 'period_start' | 'period_end'>) =>
  `${r.asset_ref} ${r.period_start}..${r.period_end} is being posted by another request. Try again shortly.`

const EARNINGS = 'gpu_earnings' as const

/**
 * Post staged rows. Unmatched, ignored and posted rows are refused (nothing is posted).
 *
 * Each row is CLAIMED first (staged → posting, with this request's claim token; lib/gpu/ops/claims.ts),
 * so a second request cannot post it and an import cannot change its figures while the entry is
 * built. Only the holder finishes or releases the claim, and it releases (back to staged) only when
 * it booked nothing — including when something throws. A request that finds the row claimed by
 * another either completes it from durable evidence (its `marketplace:<id>` entry is posted, with
 * the row's figures), takes over a claim older than CLAIM_LEASE_MS that booked nothing, or answers
 * "in progress". An entry adopted from an earlier attempt must carry the row's 1150/5150/4000 amounts.
 *
 * A row that supersedes a posted one needs the old entry reversed first. Without `confirmReversal`
 * nothing is posted and the answer lists them (`needsReversal`); with it, the old row is claimed the
 * same way (posted → reversing) so exactly one request books `reversalOf(old entry)`.
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
  const scope = { fundId, vehicleId: vehicle.vehicleId }
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return { error: 'Choose at least one row to post' }

  const rows = await loadRows(admin, fundId, ctx.vehicleId, unique)
  if (rows.length !== unique.length) return { error: 'Some of those rows are not this entity\u2019s' }
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

  /** Why an entry already under the row's ref cannot stand for it, or null when it carries the row's figures. */
  const figuresOff = (e: LiveEntry, row: EarningRow): string | null => {
    const got = { net: postedTo(e, accounts.get(RECEIVABLE_CODE)!), fee: postedTo(e, accounts.get(FEE_CODE)!), gross: -postedTo(e, accounts.get(REVENUE_CODE)!) }
    const want = { net: Number(row.net), fee: Number(row.marketplace_fee), gross: Number(row.gross) }
    const off = (['gross', 'fee', 'net'] as const).filter(k => cents(got[k]) !== cents(want[k]))
    return off.length
      ? `Entry ${e.id} already booked for this row carries ${off.map(k => `${k} ${got[k]}`).join(', ')}, but the row says ${off.map(k => `${k} ${want[k]}`).join(', ')}. Void that entry, then post again.`
      : null
  }

  const posted: { id: string; entryId: string | null }[] = []
  const reversed: { id: string; reversalId: string | null }[] = []
  const fail = (error: string): PostResult => ({ error, posted })

  for (const listed of rows) {
    let token = listed.status === 'staged' ? await takeClaim(admin, EARNINGS, scope, listed.id, 'staged', 'posting') : null
    const [row] = await loadRows(admin, fundId, ctx.vehicleId, [listed.id])
    if (row?.status === 'posted' && !token) { posted.push({ id: row.id, entryId: row.journal_entry_id }); continue }
    if (!row || row.status !== 'posting') return fail(busy(listed))

    if (!token) {
      // Another request's claim. Complete it from its booked entry, take it over once it has expired
      // with nothing booked, or say it is in progress — never release it.
      const evidence = isZeroPeriod(row) ? null : await liveEntryByRef(admin, ctx, opsSourceRef.earning(row.id))
      if (evidence?.status === 'posted') {
        const off = figuresOff(evidence, row)
        if (off) return fail(off)
        await completeFromEvidence(admin, EARNINGS, scope, row.id, 'posting', { status: 'posted', journal_entry_id: evidence.id })
        posted.push({ id: row.id, entryId: evidence.id })
        continue
      }
      if (evidence) return fail(busy(row))
      token = await takeOver(admin, EARNINGS, scope, row)
      if (!token) return fail(busy(row))
    }

    // This request holds the claim. Release it only while nothing of ours is booked.
    const mine = token
    let entryId: string | null = null
    const release = async (error: string) => { await settleClaim(admin, EARNINGS, scope, row.id, mine, { status: 'staged' }); return fail(error) }
    try {
      if (row.supersedes_id) {
        const done = await reverseSuperseded(admin, ctx, row.supersedes_id)
        if ('error' in done) return release(done.error)
        if (done.reversalId !== undefined) reversed.push({ id: row.supersedes_id, reversalId: done.reversalId })
      }
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
          const off = figuresOff(booked.booked, row)
          if (off) return release(off)
        }
        entryId = booked.booked.id
      }
    } catch (e) {
      if (!entryId) await settleClaim(admin, EARNINGS, scope, row.id, mine, { status: 'staged' }).catch(() => undefined)
      throw e
    }
    // Lost the claim to a takeover after booking: the taker completes it from the entry.
    if (!(await settleClaim(admin, EARNINGS, scope, row.id, mine, { status: 'posted', journal_entry_id: entryId }))) return fail(busy(row))
    posted.push({ id: row.id, entryId })
  }
  return { posted, reversed }
}

const reversingBusy = (old: Pick<EarningRow, 'asset_ref' | 'period_start' | 'period_end'>) =>
  `The posted entry for ${old.asset_ref} ${old.period_start}..${old.period_end} is being reversed by another request. Try again shortly.`

/**
 * Reverse the entry a superseded row booked, once, under the same claim protocol (posted →
 * reversing): the holder books `reversalOf(old entry)` and marks the row reversed, and puts it back
 * to posted if it booked nothing (a returned error or a throw); anyone completes a 'reversing' row
 * whose reversal is posted; an expired claim with no reversal is taken over and booked again.
 * `reversalId` undefined = the row was already reversed (nothing done here).
 */
async function reverseSuperseded(
  admin: SupabaseClient, ctx: Lifecycle, oldId: string,
): Promise<{ reversalId?: string | null } | { error: string }> {
  const scope = { fundId: ctx.fundId, vehicleId: ctx.vehicleId }
  const load = async () => (await loadRows(admin, ctx.fundId, ctx.vehicleId, [oldId]))[0]
  let old = await load()
  if (!old) return { error: `The superseded row ${oldId} is gone` }
  let token = old.status === 'posted' ? await takeClaim(admin, EARNINGS, scope, old.id, 'posted', 'reversing') : null
  if (token) old = await load()
  if (old.status !== 'reversing') return {}

  if (!token) {
    const evidence = old.journal_entry_id ? await liveEntryByRef(admin, ctx, reversalRef(old.journal_entry_id)) : null
    if (evidence?.status === 'posted') {
      await completeFromEvidence(admin, EARNINGS, scope, old.id, 'reversing', { status: 'reversed' })
      return { reversalId: evidence.id }
    }
    if (evidence) return { error: reversingBusy(old) }
    token = await takeOver(admin, EARNINGS, scope, old)
    if (!token) return { error: reversingBusy(old) }
  }

  const mine = token
  let reversalId: string | null = null
  const putBack = async (error: string) => { await settleClaim(admin, EARNINGS, scope, old.id, mine, { status: 'posted' }); return { error } }
  try {
    // A zero period booked nothing, so there is nothing to reverse.
    if (old.journal_entry_id) {
      const original = await originalEntry(admin, ctx.fundId, ctx.vehicleId, old.journal_entry_id)
      if (!original || original.status !== 'posted') return putBack(`Entry ${old.journal_entry_id} is not posted, so it cannot be reversed`)
      const reversal = reversalOf({
        id: original.id, fundId: ctx.fundId, entryDate: original.entry_date, memo: original.memo, sourceType: original.source_type, reference: original.reference,
        postings: ((original.journal_postings as any[]) ?? []).map(p => ({ accountId: p.account_id, amount: Number(p.amount), currency: p.currency ?? 'USD', lpEntityId: p.lp_entity_id ?? null })),
      }, old.period_end > original.entry_date ? old.period_end : original.entry_date)
      const booked = await bookOnce(admin, ctx, reversal)
      if ('error' in booked) return putBack(booked.error)
      reversalId = booked.booked.id
      // The journal's own reverse action sets this link; without it a second reverse is allowed.
      await (admin as any).from('journal_entries').update({ reversed_by: reversalId })
        .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('id', original.id)
    }
  } catch (e) {
    if (!reversalId) await settleClaim(admin, EARNINGS, scope, old.id, mine, { status: 'posted' }).catch(() => undefined)
    throw e
  }
  if (!(await settleClaim(admin, EARNINGS, scope, old.id, mine, { status: 'reversed' }))) return { error: reversingBusy(old) }
  return { reversalId }
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
