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
 * Match an expected payout to a bank inflow: draft `Dr 1000 / Cr 1150` dated the bank transaction,
 * then linkInflowToEntry posts it, retires the import's placeholder draft and marks the bank row
 * reconciled. The payout becomes `matched`.
 *
 * The inflow must equal the payout to the cent (the bank feed and 1000 then still agree). The date
 * window only decides what is OFFERED; a person may match outside it. A retry reuses the entry an
 * earlier attempt drafted (the once-only index keeps one per payout).
 */
export async function matchPayout(
  admin: SupabaseClient, fundId: string, group: string, userId: string | null, payoutId: string, txnId: string,
): Promise<{ payoutId: string; entryId: string } | { error: string }> {
  const vehicle = await fleetVehicleId(admin, fundId, group)
  if ('error' in vehicle) return vehicle
  const ctx: Lifecycle = { fundId, group, vehicleId: vehicle.vehicleId, userId }

  const { data: payout, error: payoutError } = await (admin as any).from('gpu_payouts').select('*')
    .eq('fund_id', fundId).eq('vehicle_id', ctx.vehicleId).eq('id', payoutId).maybeSingle()
  if (payoutError) throw payoutError
  if (!payout) return { error: 'Payout not found' }
  if (payout.status !== 'expected') return { error: 'This payout is already matched' }

  const { data: txn, error: txnError } = await (admin as any).from('bank_transactions').select('id, txn_date, amount, status')
    .eq('fund_id', fundId).eq('vehicle_id', ctx.vehicleId).eq('id', txnId).maybeSingle()
  if (txnError) throw txnError
  if (!txn) return { error: 'Transaction not found' }
  if (txn.status !== 'drafted' && txn.status !== 'unmatched') return { error: `That bank transaction is ${txn.status}` }
  if (cents(txn.amount) !== cents(payout.amount)) return { error: `The bank inflow (${Number(txn.amount).toFixed(2)}) is not the payout amount (${Number(payout.amount).toFixed(2)})` }

  const ref = opsSourceRef.payout(payout.id)
  let entryId: string
  let created = false
  const found = await liveEntryByRef(admin, ctx, ref)
  if (found) entryId = found.id
  else {
    const accounts = await accountIdsByCode(admin, fundId, ctx.vehicleId, [CASH_CODE, RECEIVABLE_CODE])
    const entry = buildPayoutEntry({
      fundId, payoutId: payout.id, entryDate: txn.txn_date, amount: Number(payout.amount), reference: payout.reference,
      cashAccountId: accounts.get(CASH_CODE)!, receivableAccountId: accounts.get(RECEIVABLE_CODE)!,
    })
    const saved = await persistEntry(admin, fundId, group, userId, entry, 'draft')
    if ('error' in saved) return { error: saved.error }
    entryId = saved.entryId
    created = true
  }

  const linked = await linkInflowToEntry(admin, fundId, group, txnId, entryId, userId)
  if ('error' in linked) {
    // Leave no draft of ours behind to block the close.
    if (created) await (admin as any).from('journal_entries').delete().eq('id', entryId).eq('fund_id', fundId).eq('status', 'draft')
    return linked
  }
  const { error } = await (admin as any).from('gpu_payouts').update({
    status: 'matched', bank_transaction_id: txnId, journal_entry_id: entryId, updated_at: new Date().toISOString(),
  }).eq('fund_id', fundId).eq('vehicle_id', ctx.vehicleId).eq('id', payout.id)
  if (error) return { error: error.message }
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
