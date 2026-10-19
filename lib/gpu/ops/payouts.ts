// Marketplace payouts: what the marketplace paid against posted earnings, matched to the bank
// inflow that carried it (Dr 1000 / Cr 1150), and the 1150 tie-out that shows what is still owed.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { linkInflowToEntry } from '@/lib/accounting/bank-match'
import { fetchAllRows, fetchAllRowsIn, loadPostedLedger } from '@/lib/accounting/load'
import { accountBalances, roundCents } from '@/lib/accounting/ledger'
import { persistEntry } from '@/lib/accounting/persist'
import { hasAccess, loadAccessContext } from '@/lib/access/effective'
import { accountIdsByCode, liveEntryByRef, postedTo, type Lifecycle } from '../assets'
import { buildPayoutEntry } from './entries'
import { completeFromEvidence, isStale, renewClaim, settleClaim, takeClaim, takeOver } from './claims'
import { fleetVehicleId } from './import'
import { CASH_CODE, RECEIVABLE_CODE, opsSourceRef, type PayoutRow } from './types'

/** How far a bank inflow's date may sit from the payout date and still be offered as its match. */
export const PAYOUT_WINDOW_DAYS = 7
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const cents = (n: number) => Math.round(Number(n) * 100)
const dayGap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000

export interface BankInflow { id: string; txn_date: string; amount: number; description: string | null; status: string }

/** Whether a bank inflow can be a payout's match: an inflow of the same amount (to the cent), within the window. */
export function isPayoutCandidate(p: Pick<PayoutRow, 'amount' | 'payout_date'>, t: Pick<BankInflow, 'amount' | 'txn_date'>): boolean {
  return Number(t.amount) > 0 && cents(t.amount) === cents(p.amount) && dayGap(t.txn_date, p.payout_date) <= PAYOUT_WINDOW_DAYS
}

/** The vehicle's bank inflows not yet reconciled: drafted (auto-drafted on import) or unmatched. */
export async function openInflows(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<BankInflow[]> {
  return fetchAllRows<BankInflow>((f, t) => (admin as any).from('bank_transactions')
    .select('id, txn_date, amount, description, status').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    .in('status', ['drafted', 'unmatched']).gt('amount', 0).range(f, t))
}

export async function recordPayout(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null,
  p: { date?: unknown; amount?: unknown; reference?: unknown; note?: unknown },
): Promise<{ payout: PayoutRow } | { error: string }> {
  const vehicle = await fleetVehicleId(admin, fundId, group)
  if ('error' in vehicle) return vehicle
  if (typeof p.date !== 'string' || !ISO_DATE.test(p.date)) return { error: 'date must be YYYY-MM-DD' }
  const amount = typeof p.amount === 'number' ? p.amount : Number(p.amount)
  if (!Number.isFinite(amount) || cents(amount) <= 0) return { error: 'amount must be more than zero' }
  for (const k of ['reference', 'note'] as const) {
    if (p[k] != null && typeof p[k] !== 'string') return { error: `${k} must be a string` }
  }
  const { data, error } = await (admin as any).from('gpu_payouts').insert({
    fund_id: fundId, vehicle_id: vehicle.vehicleId, payout_date: p.date, amount: cents(amount) / 100,
    reference: (p.reference as string | undefined)?.trim() || null, note: (p.note as string | undefined)?.trim() || null,
    status: 'expected', created_by: userId,
  }).select('*').single()
  if (error) return { error: error.message }
  return { payout: data as PayoutRow }
}

export type PayoutWithCandidates = PayoutRow & { candidates: BankInflow[] }

/** Every payout of the vehicle, newest first; an expected one carries the bank inflows that could be its match. */
export async function listPayouts(admin: SupabaseClient, fundId: string, group: string): Promise<PayoutWithCandidates[] | { error: string }> {
  const vehicle = await fleetVehicleId(admin, fundId, group)
  if ('error' in vehicle) return vehicle
  const payouts = await fetchAllRows<PayoutRow>((f, t) => (admin as any).from('gpu_payouts').select('*')
    .eq('fund_id', fundId).eq('vehicle_id', vehicle.vehicleId).order('payout_date', { ascending: false }).range(f, t))
  const inflows = payouts.some(p => p.status === 'expected') ? await openInflows(admin, fundId, vehicle.vehicleId) : []
  return payouts.map(p => ({ ...p, candidates: p.status === 'expected' ? inflows.filter(t => isPayoutCandidate(p, t)) : [] }))
}

/**
 * Match an expected payout to a bank inflow: `Dr 1000 / Cr 1150` dated the bank transaction, posted
 * by linkInflowToEntry, which also retires the import's placeholder draft and marks the bank row
 * reconciled. The inflow must equal the payout to the cent (the bank feed and 1000 then still agree);
 * the date window only decides what is OFFERED.
 *
 * Owned claim first (lib/gpu/ops/claims.ts): expected → matching with the bank transaction and this
 * request's token, conditionally, and gpu_payouts_one_per_bank_txn lets one payout hold a transaction.
 * Then the draft entry (its id stored on the payout), then the link, then matched — each write
 * conditional on the token. Only the holder releases, and only while the bank row is not reconciled
 * to its entry. Anyone completes a 'matching' payout whose bank row is reconciled to the payout's
 * entry; a claim older than CLAIM_LEASE_MS with no such evidence is taken over (reusing its draft).
 */
export async function matchPayout(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null, payoutId: string, txnId: string,
): Promise<{ payoutId: string; entryId: string } | { error: string }> {
  const vehicle = await fleetVehicleId(admin, fundId, group)
  if ('error' in vehicle) return vehicle
  const ctx: Lifecycle = { fundId, group, vehicleId: vehicle.vehicleId, userId }
  const scope = { fundId, vehicleId: vehicle.vehicleId }
  const PAYOUTS = 'gpu_payouts' as const
  const busy = { error: 'This payout is being matched by another request. Try again shortly.' }

  const loadPayout = async (): Promise<PayoutRow | null> => {
    const { data, error } = await (admin as any).from(PAYOUTS).select('*')
      .eq('fund_id', fundId).eq('vehicle_id', ctx.vehicleId).eq('id', payoutId).maybeSingle()
    if (error) throw error
    return data
  }
  const loadTxn = async () => {
    const { data, error } = await (admin as any).from('bank_transactions').select('id, txn_date, amount, status, journal_entry_id')
      .eq('fund_id', fundId).eq('vehicle_id', ctx.vehicleId).eq('id', txnId).maybeSingle()
    if (error) throw error
    return data as { id: string; txn_date: string; amount: number; status: string; journal_entry_id: string | null } | null
  }

  let payout = await loadPayout()
  if (!payout) return { error: 'Payout not found' }
  if (payout.status === 'matched') return { error: 'This payout is already matched' }
  if (payout.status === 'matching' && payout.bank_transaction_id !== txnId) return { error: 'This payout is being matched to another bank transaction' }
  let txn = await loadTxn()
  if (!txn) return { error: 'Transaction not found' }
  if (cents(txn.amount) !== cents(payout.amount)) return { error: `The bank inflow (${Number(txn.amount).toFixed(2)}) is not the payout amount (${Number(payout.amount).toFixed(2)})` }

  let token: string | null = null
  if (payout.status === 'expected') {
    if (txn.status !== 'drafted' && txn.status !== 'unmatched') return { error: `That bank transaction is ${txn.status}` }
    try {
      token = await takeClaim(admin, PAYOUTS, scope, payout.id, 'expected', 'matching', { bank_transaction_id: txnId })
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return { error: 'That bank transaction is already matched, or being matched, to another payout' }
      throw e
    }
    payout = await loadPayout()
    if (!payout) return { error: 'Payout not found' }
    if (!token) {
      if (payout.status === 'matched') return { error: 'This payout is already matched' }
      if (payout.status !== 'matching' || payout.bank_transaction_id !== txnId) return busy
    }
  }

  const ref = opsSourceRef.payout(payout.id)
  const reconciledTo = (entryId: string | null | undefined) => !!entryId && txn!.status === 'reconciled' && txn!.journal_entry_id === entryId
  const loadEntry = async () => liveEntryByRef(admin, ctx, ref)

  if (!token) {
    // Another request's claim. Live: in progress, judge nothing. Expired: complete it when its bank
    // row is reconciled to the payout's entry (conditional on the token observed with that), else
    // take it over.
    if (!isStale(payout)) return busy
    const evidence = await loadEntry()
    const entryId = payout.journal_entry_id ?? evidence?.id
    if (evidence?.status === 'posted' && reconciledTo(entryId)) {
      if (await completeFromEvidence(admin, PAYOUTS, scope, payout, { status: 'matched', journal_entry_id: entryId })) return { payoutId: payout.id, entryId: entryId! }
      return busy
    }
    token = await takeOver(admin, PAYOUTS, scope, payout)
    if (!token) return busy
  }

  const mine = token
  // Release, all inside the owned section: renew the lease (still the holder?), remove the draft
  // under the ref this holder owns (never a posted entry), and only then hand the payout back. Once
  // the claim is released nothing here touches the ref: a new match may already hold it.
  const release = async (error: string) => {
    if (!(await renewClaim(admin, PAYOUTS, scope, payout!.id, mine))) return { error }
    const left = await loadEntry()
    if (left?.status === 'draft') await (admin as any).from('journal_entries').delete().eq('id', left.id).eq('fund_id', fundId).eq('status', 'draft')
    await settleClaim(admin, PAYOUTS, scope, payout!.id, mine, { status: 'expected', bank_transaction_id: null, journal_entry_id: null })
    return { error }
  }
  const lostClaim = { error: 'This match lost its claim to another request; nothing more was booked. Try again shortly.' }
  /** Unknown or partly done: release only when nothing under the ref is posted. */
  const releaseIfUnbooked = async (error: string) => ((await loadEntry())?.status === 'posted' ? busy : release(error))

  let entryId: string
  try {
    // A posted entry the previous holder left unreconciled is linked as it is (linkInflowToEntry
    // reconciles a posted target without posting it again).
    let existing = await loadEntry()
    // A draft left by an earlier attempt is reused only when it books this inflow: the same date
    // and amount. Anything else is removed (this holder owns the ref) and built again.
    if (existing?.status === 'draft') {
      const cash = postedTo(existing, (await accountIdsByCode(admin, fundId, ctx.vehicleId, [CASH_CODE])).get(CASH_CODE)!)
      if (existing.entry_date !== txn.txn_date || cents(cash) !== cents(payout.amount)) {
        if (!(await renewClaim(admin, PAYOUTS, scope, payout.id, mine))) return lostClaim
        await (admin as any).from('journal_entries').delete().eq('id', existing.id).eq('fund_id', fundId).eq('status', 'draft')
        existing = null
      }
    }
    if (!existing) {
      const accounts = await accountIdsByCode(admin, fundId, ctx.vehicleId, [CASH_CODE, RECEIVABLE_CODE])
      const entry = buildPayoutEntry({
        fundId, payoutId: payout.id, entryDate: txn.txn_date, amount: Number(payout.amount), reference: payout.reference,
        cashAccountId: accounts.get(CASH_CODE)!, receivableAccountId: accounts.get(RECEIVABLE_CODE)!,
      })
      if (!(await renewClaim(admin, PAYOUTS, scope, payout.id, mine))) return lostClaim
      const saved = await persistEntry(admin, fundId, group, userId, entry, 'draft')
      if ('error' in saved) return releaseIfUnbooked(saved.error)
      entryId = saved.entryId
    } else entryId = existing.id
    const { data: stored, error: storeError } = await (admin as any).from(PAYOUTS).update({ journal_entry_id: entryId, updated_at: new Date().toISOString() })
      .eq('fund_id', fundId).eq('id', payout.id).eq('claim_token', mine).select('id')
    if (storeError) return releaseIfUnbooked(storeError.message)
    if (!((stored as any[]) ?? []).length) return lostClaim

    if (!reconciledTo(entryId)) {
      if (txn.status !== 'drafted' && txn.status !== 'unmatched') return releaseIfUnbooked(`That bank transaction is ${txn.status}`)
      if (!(await renewClaim(admin, PAYOUTS, scope, payout.id, mine))) return lostClaim
      const result = await linkInflowToEntry(admin, fundId, group, txnId, entryId, userId)
      if ('error' in result) {
        // Refused or failed: finished if the bank row ended up reconciled to our entry; in progress
        // (claim kept) if the entry is posted; released only while it is still a draft.
        txn = await loadTxn()
        if (!reconciledTo(entryId)) return releaseIfUnbooked(result.error)
      }
    }
  } catch (e) {
    // Unknown outcome (linkInflowToEntry can throw after posting): keep the claim, the links and any
    // draft. Nothing is released or deleted from here; once the claim expires the next match
    // completes it from the reconciled bank row, or takes it over and reuses or rebuilds the draft.
    throw e
  }
  // Booked and reconciled. If the settle did not take, another request may have finished it with
  // this same entry: that is success. Otherwise matching again completes it from the evidence.
  const finished = await settleClaim(admin, PAYOUTS, scope, payout.id, mine, { status: 'matched' }).catch(() => false)
  if (!finished) {
    const now = await loadPayout().catch(() => null)
    if (now?.status === 'matched' && now.journal_entry_id === entryId) return { payoutId: payout.id, entryId }
    return { error: 'The payment is booked and reconciled, but the payout could not be marked matched. Match it again to finish.' }
  }
  return { payoutId: payout.id, entryId }
}

export interface ReceivableTieOut {
  asOf: string
  /** 1150's posted balance through asOf. */
  ledger1150: number
  /** Σ net of posted earnings whose period ends by asOf. */
  postedNet: number
  /** Σ matched payouts whose entry is dated by asOf. */
  matchedPayouts: number
  /** postedNet − matchedPayouts: what 1150 should hold. */
  expected: number
  /** ledger1150 − expected. Non-zero = something reached 1150 outside this pipeline, or the reverse. */
  difference: number
}

/** The marketplace receivable against the operations subledger, as of a date. */
export async function receivableTieOut(admin: SupabaseClient, fundId: string, group: string, asOf: string): Promise<ReceivableTieOut | { error: string }> {
  const vehicle = await fleetVehicleId(admin, fundId, group)
  if ('error' in vehicle) return vehicle
  const { vehicleId } = vehicle
  const [ledger, earnings, payouts] = await Promise.all([
    loadPostedLedger(admin, fundId, group, asOf),
    fetchAllRows<{ net: number }>((f, t) => (admin as any).from('gpu_earnings').select('id, net')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'posted').lte('period_end', asOf).range(f, t)),
    fetchAllRows<{ amount: number; journal_entry_id: string | null }>((f, t) => (admin as any).from('gpu_payouts').select('id, amount, journal_entry_id')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'matched').range(f, t)),
  ])
  const entryIds = payouts.map(p => p.journal_entry_id).filter((v): v is string => !!v)
  const dated = new Set((await fetchAllRowsIn<{ id: string }>(entryIds, (chunk, f, t) => (admin as any).from('journal_entries').select('id')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('status', 'posted').lte('entry_date', asOf).in('id', chunk).range(f, t))).map(e => e.id))

  const account = ledger.accounts.find(a => a.code === RECEIVABLE_CODE)
  const ledger1150 = account ? accountBalances(ledger.postings).get(account.id) ?? 0 : 0
  const postedNet = earnings.reduce((s, e) => s + cents(e.net), 0) / 100
  const matchedPayouts = payouts.filter(p => p.journal_entry_id && dated.has(p.journal_entry_id)).reduce((s, p) => s + cents(p.amount), 0) / 100
  const expected = roundCents(postedNet - matchedPayouts)
  return { asOf, ledger1150, postedNet, matchedPayouts, expected, difference: roundCents(ledger1150 - expected) }
}

/**
 * What the bank auto-match may do with a GPU SPV's expected payouts for this caller (#92):
 *   - 'off'     — no caller, no membership, or no `fleet` write (which includes gpu_fleet being off
 *                 or hidden: fleet then resolves to none, admins included). The pool is skipped.
 *   - 'propose' — the default: report the fitting payout, book nothing.
 *   - 'post'    — the vehicle's gpu_fleet_settings.auto_post_payout_matches is on: book it.
 */
export async function payoutAutoMatchMode(admin: SupabaseClient, fundId: string, group: string, userId: string | null): Promise<'off' | 'propose' | 'post'> {
  if (!userId) return 'off'
  const { data: member, error: memberError } = await (admin as any).from('fund_members').select('role')
    .eq('fund_id', fundId).eq('user_id', userId).maybeSingle()
  if (memberError) throw memberError
  if (!member) return 'off'
  const access = await loadAccessContext(admin, fundId, userId, member.role)
  if (!hasAccess(access, 'fleet', 'write')) return 'off'
  const vehicle = await fleetVehicleId(admin, fundId, group)
  if ('error' in vehicle) return 'off'
  const { data: settings, error } = await (admin as any).from('gpu_fleet_settings').select('auto_post_payout_matches')
    .eq('fund_id', fundId).eq('vehicle_id', vehicle.vehicleId).maybeSingle()
  if (error) throw error
  return settings?.auto_post_payout_matches === true ? 'post' : 'propose'
}
