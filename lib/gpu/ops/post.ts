// Post staged GPU operations rows to the ledger: one entry per row (one server, one period).
//
// The caller has checked `fleet` write AND `accounting` write: this books revenue.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { fetchAllRowsIn, IN_CHUNK } from '@/lib/accounting/load'
import { reversalOf, reversalRef } from '@/lib/accounting/reversal'
import { postExistingEntryWithAllocation } from '@/lib/accounting/continuous-allocation'
import type { JournalEntry } from '@/lib/accounting/types'
import { accountIdsByCode, bookOnce, inProgress, liveEntryByRef, postedTo, type Lifecycle, type LiveEntry } from '../assets'
import { completeFromEvidence, isStale, renewClaim, settleClaim, takeClaim, takeOver } from './claims'
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
  const env: BookEnv = { admin, ctx, scope }

  for (const listed of rows) {
    let token = listed.status === 'staged' ? await takeClaim(admin, EARNINGS, scope, listed.id, 'staged', 'posting') : null
    let [row] = await loadRows(admin, fundId, ctx.vehicleId, [listed.id])
    if (row?.status === 'posted' && !token) { posted.push({ id: row.id, entryId: row.journal_entry_id }); continue }
    if (!row || row.status !== 'posting') return fail(busy(listed))
    const ref = opsSourceRef.earning(row.id)

    if (!token) {
      // Another request's claim. While it is live the holder may still be inside persistEntry (whose
      // posted entry can yet be discarded), so say "in progress" and judge nothing. Once it has
      // expired: complete from its posted entry, name a draft it left, or take it over.
      if (!isStale(row)) return fail(busy(row))
      const evidence = isZeroPeriod(row) ? null : await liveEntryByRef(admin, ctx, ref)
      if (evidence?.status === 'posted') {
        const off = figuresOff(evidence, row)
        if (off) return fail(off)
        if (await completeFromEvidence(admin, EARNINGS, scope, row, { status: 'posted', journal_entry_id: evidence.id })) {
          posted.push({ id: row.id, entryId: evidence.id })
          continue
        }
        ;[row] = await loadRows(admin, fundId, ctx.vehicleId, [listed.id])
        if (row?.status === 'posted') { posted.push({ id: row.id, entryId: row.journal_entry_id }); continue }
        return fail(busy(listed))
      }
      if (evidence) return fail(inProgress(evidence).error)
      token = await takeOver(admin, EARNINGS, scope, row)
      if (!token) return fail(busy(row))
    }

    // This request holds the claim. It releases (back to staged) only when it can see that nothing
    // under the row's ref is on the books; any other outcome keeps the claim.
    const holder: Holder = { table: EARNINGS, id: row.id, token }
    const release = async (error: string) => { await settleClaim(admin, EARNINGS, scope, row.id, holder.token, { status: 'staged' }); return fail(error) }
    const keep = (error: string) => fail(error)
    let entryId: string | null = null
    try {
      if (row.supersedes_id) {
        const done = await reverseSuperseded(env, row.supersedes_id, row)
        if ('error' in done) return done.keep ? keep(done.error) : release(done.error)
        if (done.reversalId !== undefined) reversed.push({ id: row.supersedes_id, reversalId: done.reversalId })
      }
      if (!isZeroPeriod(row)) {
        const entry = buildEarningsEntry({
          fundId, earningId: row.id, assetName: nameOf.get(row.asset_id!) ?? row.asset_ref,
          periodStart: row.period_start, periodEnd: row.period_end,
          gross: Number(row.gross), fee: Number(row.marketplace_fee), net: Number(row.net),
          receivableAccountId: accounts.get(RECEIVABLE_CODE)!, feeAccountId: accounts.get(FEE_CODE)!, revenueAccountId: accounts.get(REVENUE_CODE)!,
        })
        const booked = await bookAsHolder(env, holder, entry, e => figuresOff(e, row))
        if ('error' in booked) return booked.keep ? keep(booked.error) : release(booked.error)
        entryId = booked.entryId
      }
    } catch (e) {
      // Unknown outcome: release only when nothing under the ref is on the books.
      if (!entryId && !(await refHasEntry(env, ref).catch(() => true))) {
        await settleClaim(admin, EARNINGS, scope, row.id, holder.token, { status: 'staged' }).catch(() => undefined)
      }
      throw e
    }
    // Lost the claim to a takeover after booking: the taker completes it from the entry.
    if (!(await settleClaim(admin, EARNINGS, scope, row.id, holder.token, { status: 'posted', journal_entry_id: entryId }))) return fail(busy(row))
    posted.push({ id: row.id, entryId })
  }
  return { posted, reversed }
}

interface BookEnv { admin: SupabaseClient; ctx: Lifecycle; scope: { fundId: string; vehicleId: string } }
interface Holder { table: typeof EARNINGS; id: string; token: string }

/** Whether any live entry (posted or draft) carries `ref`. */
async function refHasEntry(env: BookEnv, ref: string): Promise<boolean> {
  return !!(await liveEntryByRef(env.admin, env.ctx, ref))
}

/** Why `e` is not `expected` (per-account totals to the cent), or null when it is. */
function differsFrom(e: LiveEntry, expected: JournalEntry): string | null {
  const want = new Map<string, number>()
  for (const p of expected.postings) want.set(p.accountId, (want.get(p.accountId) ?? 0) + cents(p.amount))
  const got = new Map<string, number>()
  for (const p of e.journal_postings ?? []) got.set(p.account_id, (got.get(p.account_id) ?? 0) + cents(p.amount))
  const accounts = new Set([...want.keys(), ...got.keys()])
  const same = Array.from(accounts).every(a => (want.get(a) ?? 0) === (got.get(a) ?? 0))
  return same ? null : `Entry ${e.id} (${e.entry_date}) under ${expected.sourceRef} does not carry the expected lines. Void it, then post again.`
}

/**
 * Book `entry` as the holder of a claim. Fenced: the lease is renewed right before the write, and
 * a holder that has lost its token aborts before inserting anything. A draft found under the ref
 * (the previous holder's, after a takeover) is posted by this holder, which owns the ref now; if
 * that post is refused because the previous holder posted it meanwhile, the entry is re-read and
 * taken when it carries the right lines. Anything unknown keeps the claim (`keep: true`); only a
 * refusal that left nothing on the books may release it (`keep: false`).
 */
async function bookAsHolder(
  env: BookEnv, holder: Holder, entry: JournalEntry, check: (e: LiveEntry) => string | null,
): Promise<{ entryId: string } | { error: string; keep: boolean }> {
  const { admin, ctx, scope } = env
  const lost = { error: 'This post lost its claim to another request; nothing more was booked. Try again shortly.', keep: true }
  if (!(await renewClaim(admin, holder.table, scope, holder.id, holder.token))) return lost
  const booked = await bookOnce(admin, ctx, entry)
  if (!('error' in booked)) {
    if (booked.adopted) {
      const off = check(booked.booked)
      if (off) return { error: off, keep: false }
    }
    return { entryId: booked.booked.id }
  }
  if (!booked.inProgress) {
    // persistEntry refused (a closed period, a missing account): nothing of ours is on the books,
    // unless it kept a draft — which keeps the claim.
    return { error: booked.error, keep: await refHasEntry(env, entry.sourceRef!) }
  }
  const draft = await liveEntryByRef(admin, ctx, entry.sourceRef!)
  if (draft?.status === 'draft') {
    const off = check(draft)
    if (off) return { error: inProgress(draft).error, keep: true }
    if (!(await renewClaim(admin, holder.table, scope, holder.id, holder.token))) return lost
    const result = await postExistingEntryWithAllocation(admin, ctx.fundId, ctx.group, ctx.userId, draft.id)
    if (!('error' in result)) return { entryId: draft.id }
  }
  const again = await liveEntryByRef(admin, ctx, entry.sourceRef!)
  if (again?.status === 'posted' && !check(again)) return { entryId: again.id }
  return { error: again ? inProgress(again).error : lost.error, keep: true }
}

const reversingBusy = (old: Pick<EarningRow, 'asset_ref' | 'period_start' | 'period_end'>) =>
  `The posted entry for ${old.asset_ref} ${old.period_start}..${old.period_end} is being reversed by another request. Try again shortly.`
const replaced = (old: Pick<EarningRow, 'asset_ref' | 'period_start' | 'period_end'>) =>
  `This correction of ${old.asset_ref} ${old.period_start}..${old.period_end} was entered against figures that have since been replaced. Enter it again.`

/**
 * Reverse the entry a superseded row booked, once, under the same claim protocol (posted →
 * reversing). The holder books `reversalOf(old entry)` (fenced, as bookAsHolder) and marks the row
 * reversed; it puts the row back to posted only when no reversal is on the books. A live claim of
 * another request is "in progress"; an expired one is completed from its posted reversal, named
 * when it left a draft, or taken over. A predecessor already reversed counts as done only when no
 * other posted row stands for the period — otherwise this correction was based on a replaced
 * version. `reversalId` undefined = nothing was done here.
 */
async function reverseSuperseded(
  env: BookEnv, oldId: string, correction: EarningRow,
): Promise<{ reversalId?: string | null } | { error: string; keep: boolean }> {
  const { admin, ctx, scope } = env
  const load = async () => (await loadRows(admin, ctx.fundId, ctx.vehicleId, [oldId]))[0]
  let old = await load()
  if (!old) return { error: `The superseded row ${oldId} is gone`, keep: false }
  let token = old.status === 'posted' ? await takeClaim(admin, EARNINGS, scope, old.id, 'posted', 'reversing') : null
  old = await load()

  if (old.status === 'reversed' && !token) {
    // Done already — by an earlier attempt of this correction, or by another correction that has
    // since posted for the same period (then this one is stale).
    const { data: standing, error } = await (admin as any).from('gpu_earnings').select('id')
      .eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('asset_id', old.asset_id)
      .eq('period_start', old.period_start).eq('period_end', old.period_end)
      .in('status', ['posting', 'posted', 'reversing']).neq('id', correction.id).limit(1)
    if (error) throw error
    return ((standing as any[]) ?? []).length ? { error: replaced(old), keep: false } : {}
  }
  if (old.status !== 'reversing') return { error: replaced(old), keep: false }

  const ref = old.journal_entry_id ? reversalRef(old.journal_entry_id) : null
  if (!token) {
    if (!isStale(old)) return { error: reversingBusy(old), keep: false }
    const evidence = ref ? await liveEntryByRef(admin, ctx, ref) : null
    if (evidence?.status === 'posted') {
      if (await completeFromEvidence(admin, EARNINGS, scope, old, { status: 'reversed' })) return { reversalId: evidence.id }
      return { error: reversingBusy(old), keep: false }
    }
    if (evidence) return { error: inProgress(evidence).error, keep: false }
    token = await takeOver(admin, EARNINGS, scope, old)
    if (!token) return { error: reversingBusy(old), keep: false }
  }

  const holder: Holder = { table: EARNINGS, id: old.id, token }
  const putBack = async (error: string) => { await settleClaim(admin, EARNINGS, scope, old.id, holder.token, { status: 'posted' }); return { error, keep: false } }
  let reversalId: string | null = null
  try {
    // A zero period booked nothing, so there is nothing to reverse.
    if (old.journal_entry_id) {
      const original = await originalEntry(admin, ctx.fundId, ctx.vehicleId, old.journal_entry_id)
      if (!original || original.status !== 'posted') return putBack(`Entry ${old.journal_entry_id} is not posted, so it cannot be reversed`)
      const reversal = reversalOf({
        id: original.id, fundId: ctx.fundId, entryDate: original.entry_date, memo: original.memo, sourceType: original.source_type, reference: original.reference,
        postings: ((original.journal_postings as any[]) ?? []).map(p => ({ accountId: p.account_id, amount: Number(p.amount), currency: p.currency ?? 'USD', lpEntityId: p.lp_entity_id ?? null })),
      }, old.period_end > original.entry_date ? old.period_end : original.entry_date)
      const booked = await bookAsHolder(env, holder, reversal, e => differsFrom(e, reversal))
      if ('error' in booked) return booked.keep ? { error: booked.error, keep: true } : putBack(booked.error)
      reversalId = booked.entryId
      // The journal's own reverse action sets this link; without it a second reverse is allowed.
      const { error: linkError } = await (admin as any).from('journal_entries').update({ reversed_by: reversalId })
        .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('id', original.id)
      if (linkError) throw linkError
    }
  } catch (e) {
    if (!reversalId && !(ref && (await refHasEntry(env, ref).catch(() => true)))) {
      await settleClaim(admin, EARNINGS, scope, old.id, holder.token, { status: 'posted' }).catch(() => undefined)
    }
    throw e
  }
  if (!(await settleClaim(admin, EARNINGS, scope, old.id, holder.token, { status: 'reversed' }))) return { error: reversingBusy(old), keep: true }
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
