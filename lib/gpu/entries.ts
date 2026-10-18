// Journal-entry builders for the fleet lifecycle (design §2.6), pure.
//
// Each returns one balanced JournalEntry with a deterministic source_ref, so persistEntry refuses a
// retry rather than booking it twice. Account ids are resolved by the caller (assets.ts provisions
// the per-asset 1600-<a> / 1650-<a>). Signs follow lib/accounting/types.ts: debit > 0, credit < 0.

import { assertBalanced } from '@/lib/accounting/ledger'
import type { JournalEntry, Posting } from '@/lib/accounting/types'
import type { MonthKey } from '@/lib/forecast/months'
import { monthEnd } from './depreciation'

export const gpuSourceRef = {
  purchase: (assetId: string) => `gpu-asset:${assetId}:purchase`,
  capex: (assetId: string, n: number) => `gpu-asset:${assetId}:capex:${n}`,
  depreciation: (assetId: string, month: MonthKey) => `gpu-dep:${assetId}:${month}`,
  disposal: (assetId: string) => `gpu-asset:${assetId}:disposal`,
}

interface Base {
  fundId: string
  entryDate: string
  memo?: string
  currency?: string
}

const cents = (n: number) => Math.round(n * 100)

function entry(base: Base, sourceType: string, sourceRef: string, legs: [string, number][]): JournalEntry {
  const currency = base.currency ?? 'USD'
  const postings: Posting[] = legs
    .filter(([, c]) => c !== 0)
    .map(([accountId, c]) => ({ accountId, amount: c / 100, currency, lpEntityId: null }))
  const out: JournalEntry = { fundId: base.fundId, entryDate: base.entryDate, memo: base.memo, sourceType, sourceRef, postings }
  assertBalanced(out)
  return out
}

/** Purchase: Dr 1600-<a> / Cr 1000 (wired) or 2000 (invoiced). */
export function buildPurchaseEntry(
  base: Base,
  p: { assetId: string; amount: number; costAccountId: string; offsetAccountId: string },
): JournalEntry {
  const c = cents(p.amount)
  return entry(base, 'manual', gpuSourceRef.purchase(p.assetId), [[p.costAccountId, c], [p.offsetAccountId, -c]])
}

/** Capitalized shipping, installation or spares (decision R8/Q6): Dr 1600-<a> / Cr 1000 or 2000. */
export function buildCapexEntry(
  base: Base,
  p: { assetId: string; n: number; amount: number; costAccountId: string; offsetAccountId: string },
): JournalEntry {
  const c = cents(p.amount)
  return entry(base, 'manual', gpuSourceRef.capex(p.assetId, p.n), [[p.costAccountId, c], [p.offsetAccountId, -c]])
}

/** One month's depreciation, dated at month end: Dr 5300 / Cr 1650-<a>. */
export function buildDepreciationEntry(
  p: { fundId: string; assetId: string; month: MonthKey; amount: number; expenseAccountId: string; accumulatedAccountId: string; memo?: string; currency?: string },
): JournalEntry {
  const c = cents(p.amount)
  return entry(
    { fundId: p.fundId, entryDate: monthEnd(p.month), memo: p.memo ?? `Depreciation — ${p.month}`, currency: p.currency },
    'partnership_expense', gpuSourceRef.depreciation(p.assetId, p.month),
    [[p.expenseAccountId, c], [p.accumulatedAccountId, -c]],
  )
}

/**
 * Disposal: Dr cash proceeds, Dr 1650-<a> accumulated, Cr 1600-<a> cost, and 4500 takes the
 * difference (credit a gain, debit a loss; no line at all when sold at book).
 *
 * `cost` and `accumulated` are the asset accounts' LEDGER balances as positive magnitudes, not the
 * schedule's, so the entry clears both accounts to zero even after a manual correction.
 */
export function buildDisposalEntry(
  base: Base,
  p: {
    assetId: string; proceeds: number; cost: number; accumulated: number
    cashAccountId: string; costAccountId: string; accumulatedAccountId: string; gainAccountId: string
  },
): { entry: JournalEntry; gain: number } {
  const proceeds = cents(p.proceeds)
  const cost = cents(p.cost)
  const accumulated = cents(p.accumulated)
  const gain = proceeds + accumulated - cost
  return {
    gain: gain / 100,
    entry: entry(base, 'realized_gain', gpuSourceRef.disposal(p.assetId), [
      [p.cashAccountId, proceeds],
      [p.accumulatedAccountId, accumulated],
      [p.costAccountId, -cost],
      [p.gainAccountId, -gain],
    ]),
  }
}
