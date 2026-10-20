// ── GPU fleet (P3) ── The operations subledger's pre-close checks for a GPU SPV, called from
// checkReadiness (lib/accounting/close.ts). Kept here so close.ts carries one labelled call.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { fetchAllRows, fetchAllRowsIn, loadPostedLedger } from '@/lib/accounting/load'
import { reversalRef } from '@/lib/accounting/reversal'
import { receivableTieOut } from './payouts'
import { FEE_CODE, REVENUE_CODE, opsSourceRef } from './types'

const cents = (n: number) => Math.round(Number(n) * 100)
const money = (c: number) => (c / 100).toFixed(2)

/**
 * Over [start, end]:
 *   - blocker: posted rows' gross ≠ 4000 posted activity, or their fees ≠ 5150 activity (to the
 *     cent) — revenue reached the ledger outside the subledger, or the reverse. Only once the
 *     vehicle uses the subledger (any gpu_earnings row with period_end by the span end): revenue
 *     booked by hand has nothing to tie to;
 *   - blocker: an unmatched row (revenue entered against no server, so it can never post);
 *   - warning: a staged row (revenue entered but not posted);
 *   - blocker: a row being posted or reversed, or a payout being matched (an in-flight or abandoned
 *     claim: the books may or may not hold its entry), naming any draft left under its ref;
 *   - blocker: a posted entry with more than one live reversal;
 *   - warning: 1150 at `end` ≠ posted net − matched payouts.
 */
export async function gpuOpsCloseIssues(
  admin: SupabaseClient, fundId: string, group: string, vehicleId: string, start: string, end: string,
): Promise<{ blockers: string[]; warnings: string[] }> {
  const blockers: string[] = []
  const warnings: string[] = []

  const [rows, ledger] = await Promise.all([
    fetchAllRows<{ id: string; status: string; gross: number; marketplace_fee: number; asset_ref: string; period_start: string; period_end: string; journal_entry_id: string | null }>((f, t) => (admin as any).from('gpu_earnings')
      .select('id, status, gross, marketplace_fee, asset_ref, period_start, period_end, journal_entry_id').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .gte('period_end', start).lte('period_end', end).range(f, t)),
    loadPostedLedger(admin, fundId, group, end),
  ])

  const posted = rows.filter(r => r.status === 'posted')
  const ids = new Map(ledger.accounts.map(a => [a.id, a.code]))
  const activity = (code: string) => ledger.postings
    .filter(p => ids.get(p.accountId) === code && (p.entryDate ?? '') >= start)
    .reduce((s, p) => s + cents(p.amount), 0)
  const subGross = posted.reduce((s, r) => s + cents(r.gross), 0)
  const subFee = posted.reduce((s, r) => s + cents(r.marketplace_fee), 0)
  const ledgerRevenue = -activity(REVENUE_CODE)
  const ledgerFee = activity(FEE_CODE)
  // The tie holds only once the vehicle keeps its revenue in the operations subledger, as of this
  // span: a GPU SPV that books rental revenue by hand — or a month before its first operations row
  // — has nothing to tie to.
  const { data: anyRow, error: anyError } = await (admin as any).from('gpu_earnings').select('id')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).lte('period_end', end).limit(1)
  if (anyError) throw anyError
  const subledgerInUse = ((anyRow as any[]) ?? []).length > 0
  if (subledgerInUse && subGross !== ledgerRevenue) {
    blockers.push(`GPU revenue does not tie: posted operations entries total ${money(subGross)} gross, but 4000 Rental revenue shows ${money(ledgerRevenue)} for this span. Find the entry booked outside GPU operations (or the operations entry not on the books) before closing.`)
  }
  if (subledgerInUse && subFee !== ledgerFee) {
    blockers.push(`Marketplace fees do not tie: posted operations entries total ${money(subFee)}, but 5150 shows ${money(ledgerFee)} for this span.`)
  }

  const unmatched = rows.filter(r => r.status === 'unmatched').length
  if (unmatched) {
    blockers.push(`${unmatched} GPU operations row${unmatched === 1 ? '' : 's'} in this span match${unmatched === 1 ? 'es' : ''} no server. Correct the asset name and enter it again, or ignore the row, on the Revenue page.`)
  }
  // A post or reversal in flight (or abandoned, until its claim expires): its entry may or may not
  // be on the books, so neither tie above can be trusted for that row.
  // A draft left under the row's ref will not go away by waiting: name it.
  const draftUnder = async (ref: string | null) => {
    if (!ref) return null
    const { data, error } = await (admin as any).from('journal_entries').select('id')
      .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('source_ref', ref).eq('status', 'draft').order('id').limit(1)
    if (error) throw error
    return ((data as any[]) ?? [])[0]?.id as string | undefined ?? null
  }
  const what = (draft: string | null, verb: string) => draft
    ? `void draft ${draft} or post it, then ${verb} again, before closing.`
    : `${verb} again, or wait for the claim to expire, before closing.`
  for (const r of rows.filter(r => r.status === 'posting' || r.status === 'reversing')) {
    const ref = r.status === 'posting' ? opsSourceRef.earning(r.id) : r.journal_entry_id ? reversalRef(r.journal_entry_id) : null
    blockers.push(`GPU revenue for ${r.asset_ref} ${r.period_start}..${r.period_end} is ${r.status === 'posting' ? 'being posted' : 'being reversed'}: ${what(await draftUnder(ref), 'post')}`)
  }
  // In the span by its payout date OR by the claimed inflow's date — the entry is dated the inflow.
  const claimedPayouts = await fetchAllRows<{ id: string; payout_date: string; amount: number; reference: string | null; bank_transaction_id: string | null }>((f, t) => (admin as any).from('gpu_payouts')
    .select('id, payout_date, amount, reference, bank_transaction_id').eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'matching').range(f, t))
  const inflowDates = new Map((await fetchAllRowsIn<{ id: string; txn_date: string }>(claimedPayouts.map(p => p.bank_transaction_id).filter((v): v is string => !!v),
    (chunk, f, t) => (admin as any).from('bank_transactions').select('id, txn_date').eq('fund_id', fundId).in('id', chunk).range(f, t))).map(t => [t.id, t.txn_date]))
  const inSpan = (d: string | null | undefined) => !!d && d >= start && d <= end
  const matching = claimedPayouts.filter(p => inSpan(p.payout_date) || inSpan(p.bank_transaction_id ? inflowDates.get(p.bank_transaction_id) : null))
  for (const p of matching) {
    blockers.push(`The marketplace payout of ${Number(p.amount).toFixed(2)} on ${p.payout_date}${p.reference ? ` (${p.reference})` : ''} is being matched: ${what(await draftUnder(opsSourceRef.payout(p.id)), 'match')}`)
  }

  // A posted entry reversed twice (a holder that paused past its lease between its fence and its
  // insert — the residual race the claims accept): never silent.
  const reversedEntries = rows.filter(r => (r.status === 'reversed' || r.status === 'reversing') && r.journal_entry_id).map(r => r.journal_entry_id!)
  if (reversedEntries.length) {
    const reversals = await fetchAllRowsIn<{ id: string; source_ref: string }>(reversedEntries.map(reversalRef), (chunk, f, t) => (admin as any).from('journal_entries')
      .select('id, source_ref').eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).neq('status', 'void').in('source_ref', chunk).range(f, t))
    const count = new Map<string, string[]>()
    for (const e of reversals) count.set(e.source_ref, [...(count.get(e.source_ref) ?? []), e.id])
    for (const [ref, ids] of count) {
      if (ids.length > 1) blockers.push(`GPU revenue entry ${ref.slice('reversal:'.length)} is reversed ${ids.length} times (entries ${ids.join(', ')}). Void all but one before closing.`)
    }
  }

  const staged = rows.filter(r => r.status === 'staged').length
  if (staged) {
    warnings.push(`${staged} GPU operations row${staged === 1 ? ' is' : 's are'} entered but not posted in this span: that revenue is not in the books yet.`)
  }

  const tie = await receivableTieOut(admin, fundId, group, end)
  if ('error' in tie) throw new Error(tie.error)
  if (cents(tie.difference) !== 0) {
    warnings.push(`1150 Marketplace receivable is ${tie.ledger1150.toFixed(2)} at ${end}, but posted net revenue less matched payouts is ${tie.expected.toFixed(2)} (difference ${tie.difference.toFixed(2)}).`)
  }
  return { blockers, warnings }
}
