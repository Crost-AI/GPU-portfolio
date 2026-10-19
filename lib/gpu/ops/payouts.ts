// Marketplace payouts: what the marketplace paid against posted earnings, matched to the bank
// inflow that carried it (Dr 1000 / Cr 1150), and the 1150 tie-out that shows what is still owed.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { linkInflowToEntry } from '@/lib/accounting/bank-match'
import { fetchAllRows, fetchAllRowsIn, loadPostedLedger } from '@/lib/accounting/load'
import { accountBalances, roundCents } from '@/lib/accounting/ledger'
import { persistEntry } from '@/lib/accounting/persist'
import { accountIdsByCode, liveEntryByRef, type Lifecycle } from '../assets'
import { buildPayoutEntry } from './entries'
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
 * Claim first: the payout flips expected → matching with the bank transaction on it, conditionally,
 * and gpu_payouts_one_per_bank_txn lets one payout hold a transaction — so two payouts racing for one
 * inflow cannot both book. Then the draft entry (its id stored on the payout), then the link, then
 * `matched`. A payout left `matching` by a failed attempt is finished by matching it again to the same
 * transaction: the entry is reused, and a link that already happened is not repeated.
 */
export async function matchPayout(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null, payoutId: string, txnId: string,
): Promise<{ payoutId: string; entryId: string } | { error: string }> {
  const vehicle = await fleetVehicleId(admin, fundId, group)
  if ('error' in vehicle) return vehicle
  const ctx: Lifecycle = { fundId, group, vehicleId: vehicle.vehicleId, userId }
  const payouts = () => (admin as any).from('gpu_payouts')

  const { data: payout, error: payoutError } = await payouts().select('*')
    .eq('fund_id', fundId).eq('vehicle_id', ctx.vehicleId).eq('id', payoutId).maybeSingle()
  if (payoutError) throw payoutError
  if (!payout) return { error: 'Payout not found' }
  if (payout.status === 'matched') return { error: 'This payout is already matched' }
  if (payout.status === 'matching' && payout.bank_transaction_id !== txnId) return { error: 'This payout is being matched to another bank transaction' }

  const { data: txn, error: txnError } = await (admin as any).from('bank_transactions').select('id, txn_date, amount, status, journal_entry_id')
    .eq('fund_id', fundId).eq('vehicle_id', ctx.vehicleId).eq('id', txnId).maybeSingle()
  if (txnError) throw txnError
  if (!txn) return { error: 'Transaction not found' }
  if (cents(txn.amount) !== cents(payout.amount)) return { error: `The bank inflow (${Number(txn.amount).toFixed(2)}) is not the payout amount (${Number(payout.amount).toFixed(2)})` }

  if (payout.status === 'expected') {
    if (txn.status !== 'drafted' && txn.status !== 'unmatched') return { error: `That bank transaction is ${txn.status}` }
    const { data: claimed, error: claimError } = await payouts().update({ status: 'matching', bank_transaction_id: txnId, updated_at: new Date().toISOString() })
      .eq('fund_id', fundId).eq('vehicle_id', ctx.vehicleId).eq('id', payout.id).eq('status', 'expected').select('id')
    if (claimError) {
      if (claimError.code === '23505') return { error: 'That bank transaction is already matched, or being matched, to another payout' }
      throw claimError
    }
    if (!((claimed as any[]) ?? []).length) return { error: 'This payout is being matched by another request. Try again shortly.' }
  }
  // From here the payout holds the transaction. A failure before the link hands it back.
  const release = async (error: string, draftId?: string) => {
    if (draftId) await (admin as any).from('journal_entries').delete().eq('id', draftId).eq('fund_id', fundId).eq('status', 'draft')
    await payouts().update({ status: 'expected', bank_transaction_id: null, journal_entry_id: null, updated_at: new Date().toISOString() })
      .eq('fund_id', fundId).eq('id', payout.id).eq('status', 'matching')
    return { error }
  }

  const ref = opsSourceRef.payout(payout.id)
  let entryId: string | undefined = payout.journal_entry_id ?? (await liveEntryByRef(admin, ctx, ref))?.id
  let created: string | undefined
  if (!entryId) {
    const accounts = await accountIdsByCode(admin, fundId, ctx.vehicleId, [CASH_CODE, RECEIVABLE_CODE])
    const entry = buildPayoutEntry({
      fundId, payoutId: payout.id, entryDate: txn.txn_date, amount: Number(payout.amount), reference: payout.reference,
      cashAccountId: accounts.get(CASH_CODE)!, receivableAccountId: accounts.get(RECEIVABLE_CODE)!,
    })
    const saved = await persistEntry(admin, fundId, group, userId, entry, 'draft')
    if ('error' in saved) return release(saved.error)
    entryId = created = saved.entryId
  }
  const { error: linkError } = await payouts().update({ journal_entry_id: entryId, updated_at: new Date().toISOString() })
    .eq('fund_id', fundId).eq('id', payout.id).eq('status', 'matching')
  if (linkError) return release(linkError.message, created)

  // An earlier attempt may have linked and reconciled already; only the payout's own entry counts.
  const alreadyLinked = txn.status === 'reconciled' && txn.journal_entry_id === entryId
  if (!alreadyLinked) {
    if (txn.status !== 'drafted' && txn.status !== 'unmatched') return release(`That bank transaction is ${txn.status}`, created)
    const linked = await linkInflowToEntry(admin, fundId, group, txnId, entryId, userId)
    if ('error' in linked) return release(linked.error, created)
  }
  const { error } = await payouts().update({ status: 'matched', updated_at: new Date().toISOString() })
    .eq('fund_id', fundId).eq('vehicle_id', ctx.vehicleId).eq('id', payout.id)
  if (error) return { error: `The payment is booked and reconciled, but the payout could not be marked matched (${error.message}). Match it again to finish.` }
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
