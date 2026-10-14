// Double-entry ledger primitives: the balance invariant and balance queries.
//
// The one rule that makes the books trustworthy: every journal entry's postings
// sum to zero within each currency. If you can't say where a number goes, the
// entry won't balance — which is exactly the property we want while learning
// and while shadow-reconciling against a real fund's admin statements.

import type { Account, AccountType, JournalEntry, Posting } from './types'
import { NORMAL_SIDE } from './types'

/**
 * Round to cents to avoid binary-float drift when summing money.
 *
 * Halves round AWAY FROM ZERO, so roundCents(-x) === -roundCents(x). Entry builders write
 * roundCents(amount) on one leg and roundCents(-amount) on the other; Math.round alone rounds
 * halves toward +infinity (0.125 → 0.13 but -0.125 → -0.12), and those legs would not balance.
 * -0 is returned as 0.
 *
 * The 1e-9 nudge rounds a half cent the binary float stores as ...4999 up to the decimal-correct
 * cent (1000.005 → 1000.01, 66286.635 → 66286.64 where the old EPSILON nudge gave .63). It is
 * below the float's resolution past about 1,000,000, so a half cent there can still round down
 * (1234567.005 → 1234567.00) — symmetrically, so entries still balance.
 */
export function roundCents(n: number): number {
  const r = (Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-9)) / 100
  return r === 0 ? 0 : r
}

/**
 * Net posting amount per currency for one entry. A balanced entry yields 0 for
 * every currency; any non-zero value localizes the imbalance.
 */
export function entryImbalance(entry: JournalEntry): Record<string, number> {
  const byCurrency: Record<string, number> = {}
  for (const p of entry.postings) {
    byCurrency[p.currency] = (byCurrency[p.currency] ?? 0) + p.amount
  }
  for (const c of Object.keys(byCurrency)) {
    byCurrency[c] = roundCents(byCurrency[c])
  }
  return byCurrency
}

/** True when every currency in the entry nets to zero (to the cent). */
export function isBalanced(entry: JournalEntry): boolean {
  const imbalance = entryImbalance(entry)
  return Object.values(imbalance).every(v => v === 0)
}

/** Throws with a diagnostic if the entry doesn't balance. Use before posting. */
export function assertBalanced(entry: JournalEntry): void {
  if (entry.postings.length === 0) {
    throw new Error('Journal entry has no postings')
  }
  const imbalance = entryImbalance(entry)
  const offenders = Object.entries(imbalance).filter(([, v]) => v !== 0)
  if (offenders.length > 0) {
    const detail = offenders.map(([c, v]) => `${c}: ${v > 0 ? '+' : ''}${v}`).join(', ')
    throw new Error(`Journal entry does not balance (debits must equal credits) — ${detail}`)
  }
}

/**
 * Signed balance per account across a set of postings. Debits add, credits
 * subtract, so the raw sum is the account's balance on its debit side.
 */
export function accountBalances(postings: Posting[]): Map<string, number> {
  const balances = new Map<string, number>()
  for (const p of postings) {
    balances.set(p.accountId, roundCents((balances.get(p.accountId) ?? 0) + p.amount))
  }
  return balances
}

/**
 * A single account's balance, expressed as a positive number on the account's
 * normal side. An asset/expense with net debits, or a liability/equity/income
 * with net credits, returns a positive figure — the way it reads on a statement.
 */
export function normalBalance(account: Account, rawDebitSideBalance: number): number {
  const rounded = roundCents(rawDebitSideBalance)
  return NORMAL_SIDE[account.type] === 'debit' ? rounded : roundCents(-rounded)
}

/**
 * Per-LP equity balance from a set of postings — the raw material of a capital
 * account. Sums signed posting amounts by lp_entity_id, then flips sign so a
 * credit-normal equity balance reads positive.
 */
export function capitalByEntity(postings: Posting[]): Map<string, number> {
  const byEntity = new Map<string, number>()
  for (const p of postings) {
    if (!p.lpEntityId) continue
    byEntity.set(p.lpEntityId, roundCents((byEntity.get(p.lpEntityId) ?? 0) + p.amount))
  }
  // Equity is credit-normal: negate the debit-side sum so contributions (which
  // credit LP capital) show as positive capital.
  for (const [k, v] of Array.from(byEntity.entries())) byEntity.set(k, roundCents(-v))
  return byEntity
}

/** Convenience: build a two-line balanced entry (debit one account, credit another). */
export function simpleEntry(
  base: Omit<JournalEntry, 'postings'>,
  opts: { debit: string; credit: string; amount: number; currency?: string; lpEntityId?: string | null }
): JournalEntry {
  const currency = opts.currency ?? 'USD'
  const amount = roundCents(opts.amount)
  return {
    ...base,
    postings: [
      { accountId: opts.debit, amount, currency, lpEntityId: opts.lpEntityId ?? null },
      { accountId: opts.credit, amount: -amount, currency, lpEntityId: opts.lpEntityId ?? null },
    ],
  }
}

export type { Account, AccountType, JournalEntry, Posting }
