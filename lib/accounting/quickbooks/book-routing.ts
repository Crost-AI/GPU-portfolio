import type { LedgerBook } from '@/lib/accounting/books'
import type { QbTransaction } from './parse-journal'

/**
 * Which of our books an imported transaction belongs in. Pure.
 *
 * Some outside ledgers are kept on a TAX basis: the preparer books the year-end K-1 entries
 * (a lower-tier fund's pass-through income against the investment account, tax-basis write-offs)
 * straight into QuickBooks. Those are book-to-tax differences, not events in the fair-value ledger,
 * so they belong in the tax book, which statements read as an overlay (books.ts). Imported into the
 * actual book they misstate partners' capital until someone reverses them by hand.
 *
 * The mapping marks such source accounts `taxBook`. A transaction touching ANY of them goes to the
 * tax book WHOLE. An entry lives in one book and must balance there; splitting a transaction would
 * leave both halves out of balance, exactly as the exclusion rule in import-journal.ts refuses to.
 *
 * The book is NOT part of the entry's source ref (build-entries.ts). Moving an account's flag
 * between passes therefore leaves every ref where it was, and dedupe finds the entry in whichever
 * book an earlier pass put it.
 */
export function bookForTransaction(t: QbTransaction, taxAccounts: ReadonlySet<string>): LedgerBook {
  return taxAccounts.size > 0 && t.lines.some(l => taxAccounts.has(l.account)) ? 'tax' : 'actual'
}

/** The tax-book account that sent a transaction to the tax book, for the result's explanation. */
export function taxAccountHit(t: QbTransaction, taxAccounts: ReadonlySet<string>): string | null {
  return t.lines.find(l => taxAccounts.has(l.account))?.account ?? null
}

/**
 * The tax year an entry date falls in, when that year is closed (lib/tax/year-close.ts).
 *
 * A closed tax year is the tax book's lock: the database refuses any tax-book write dated inside
 * it (20260827000005_tax_year_close.sql). The import checks first, so a locked entry is named in
 * the review and the result instead of surfacing as a raw trigger error, and a dry run shows it.
 */
export function lockedTaxYear(entryDate: string, closedYears: ReadonlySet<number>): number | null {
  const year = Number(entryDate.slice(0, 4))
  return Number.isFinite(year) && closedYears.has(year) ? year : null
}
