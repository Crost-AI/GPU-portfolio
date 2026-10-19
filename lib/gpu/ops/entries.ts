// Journal-entry builders for GPU operations, pure. Same shape as lib/gpu/entries.ts: one balanced
// entry with a deterministic source_ref, so persistEntry (and journal_entries_gpu_ops_once) refuse a
// retry rather than booking it twice. Signs follow lib/accounting/types.ts: debit > 0, credit < 0.

import { assertBalanced } from '@/lib/accounting/ledger'
import type { JournalEntry, Posting } from '@/lib/accounting/types'
import { opsSourceRef } from './types'

const cents = (n: number) => Math.round(n * 100)

function entry(base: { fundId: string; entryDate: string; memo: string; currency?: string }, sourceType: string, sourceRef: string, legs: [string, number][]): JournalEntry {
  const currency = base.currency ?? 'USD'
  const postings: Posting[] = legs
    .filter(([, c]) => c !== 0)
    .map(([accountId, c]) => ({ accountId, amount: c / 100, currency, lpEntityId: null }))
  const out: JournalEntry = { fundId: base.fundId, entryDate: base.entryDate, memo: base.memo, sourceType, sourceRef, postings }
  assertBalanced(out)
  return out
}

/**
 * One server's revenue for one period: Dr 1150 net, Dr 5150 fee, Cr 4000 gross, dated the period
 * end. Throws (assertBalanced) when gross − fee ≠ net, which the parser already refuses, and on a
 * zero period (no postings): postEarnings never builds one for gross = fee = net = 0 (isZeroPeriod).
 */
export function buildEarningsEntry(p: {
  fundId: string; earningId: string; assetName: string; periodStart: string; periodEnd: string
  gross: number; fee: number; net: number
  receivableAccountId: string; feeAccountId: string; revenueAccountId: string; currency?: string
}): JournalEntry {
  return entry(
    { fundId: p.fundId, entryDate: p.periodEnd, memo: `GPU rental — ${p.assetName} — ${p.periodStart}..${p.periodEnd}`, currency: p.currency },
    'income', opsSourceRef.earning(p.earningId),
    [[p.receivableAccountId, cents(p.net)], [p.feeAccountId, cents(p.fee)], [p.revenueAccountId, -cents(p.gross)]],
  )
}

/** A marketplace payout arriving in the bank: Dr 1000 / Cr 1150, dated the bank transaction. */
export function buildPayoutEntry(p: {
  fundId: string; payoutId: string; entryDate: string; amount: number; reference?: string | null
  cashAccountId: string; receivableAccountId: string; currency?: string
}): JournalEntry {
  const c = cents(p.amount)
  return entry(
    { fundId: p.fundId, entryDate: p.entryDate, memo: `Marketplace payout${p.reference ? ` — ${p.reference}` : ''}`, currency: p.currency },
    'manual', opsSourceRef.payout(p.payoutId),
    [[p.cashAccountId, c], [p.receivableAccountId, -c]],
  )
}
