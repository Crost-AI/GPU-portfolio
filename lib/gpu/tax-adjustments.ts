// ── GPU fleet (P1c) ── A GPU SPV's book-to-tax differences for one tax year, per server (#68).
//
// The books depreciate each server straight line to salvage (the gpu-dep entries the close posts);
// the return takes the asset's own tax method (tax-depreciation.ts). The tax book records the
// difference, so actual + tax is tax depreciation:
//
//   - depreciation: the year's tax depreciation less the book depreciation the year's P&L carries
//     for the server — every posted actual-book entry that moves both its 1650 account and the
//     depreciation expense account (the close's gpu-dep entries, a manual correction, the reversal
//     of either), by JOURNAL date, not by the schedule month in a ref. A December charge the close
//     caught up in January is January's expense on the K-1, so it is January's book figure here;
//     measuring it any other way would deduct it twice.
//   - disposal basis: a server disposed of in the year leaves the books with book accumulated
//     depreciation; for tax it left with tax accumulated depreciation, so the tax gain differs from
//     the book gain by the cumulative difference. Reversing it into the gain also clears the server's
//     1650 account in the tax book — which holds only if each earlier year's difference is there.
//     So the earlier years' overlays are VERIFIED, server by server and year by year, against the
//     differences as computed now; a missing or stale one is reported (`unposted`) and the run
//     refuses until those years are run again, rather than clearing a balance that is not there.
//
// A server whose tax method is 'book' has no difference, and one not on the books by year end (not
// purchased, or its purchase reversed) has nothing to adjust.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows, fetchAllRowsIn } from '@/lib/accounting/load'
import { loadFleetLedger } from './fleet-ledger'
import { taxDepreciationByYear } from './valuation'

export interface FleetDepreciationDifference {
  assetId: string
  name: string
  /** The server's 1650 sub-account, which the difference adjusts. */
  accumulatedAccountId: string
  book: number
  tax: number
  /** tax − book. Positive: the return deducts more than the books expensed. */
  difference: number
}

/** One earlier year of a server disposed of in the year whose tax-book difference is not as computed now. */
export interface FleetOverlayGap {
  assetId: string
  name: string
  taxYear: number
  /** The year's tax − book difference as the ledger now gives it. */
  expected: number
  /** The difference the tax book holds for that year on the server's 1650 account. */
  posted: number
}

export interface FleetTaxYear {
  depreciation: FleetDepreciationDifference[]
  /** Cumulative tax − book accumulated depreciation of each server disposed of in the year. */
  disposals: FleetDepreciationDifference[]
  /** The disposed servers' earlier years whose tax-book difference is missing or stale. */
  unposted: FleetOverlayGap[]
  /**
   * Later years whose posted run cleared a server's cumulative difference on disposal, where this
   * year's difference for that server is not the one the tax book now holds: once this year is
   * posted, those years have to be run again.
   */
  laterDisposals: { taxYear: number; assetId: string; name: string }[]
}

const dollars = (c: number) => c / 100
const cents = (n: unknown) => Math.round(Number(n) * 100)
const yearOf = (date: string) => Number(date.slice(0, 4))

export async function loadFleetTaxYear(
  admin: SupabaseClient, fundId: string, vehicleId: string, taxYear: number,
): Promise<FleetTaxYear> {
  const yearStart = `${taxYear}-01-01`
  const yearEnd = `${taxYear}-12-31`
  const [{ assets }, depreciationAccounts, taxEntries] = await Promise.all([
    loadFleetLedger(admin, fundId, vehicleId, yearEnd),
    fetchAllRows<{ id: string }>((f, t) => (admin as any).from('chart_of_accounts').select('id')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('type', 'expense').eq('subtype', 'depreciation').range(f, t)),
    fetchAllRows<any>((f, t) => (admin as any).from('journal_entries').select('id, source_ref, source_type, journal_postings(account_id, amount)')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', 'tax').neq('status', 'void').like('source_ref', 'tax:%').range(f, t)),
  ])
  // What the live tax runs hold on each 1650 account, per tax year (credit-negative), and which
  // years cleared it on a disposal.
  const overlay = new Map<string, Map<number, number>>()
  const clearedIn = new Map<string, Set<number>>()
  for (const e of taxEntries) {
    const y = Number(String(e.source_ref).slice('tax:'.length))
    for (const p of e.journal_postings ?? []) {
      const byYear = overlay.get(p.account_id) ?? new Map<number, number>()
      byYear.set(y, (byYear.get(y) ?? 0) + cents(p.amount))
      overlay.set(p.account_id, byYear)
      if (e.source_type === 'tax_adj_disposal') clearedIn.set(p.account_id, (clearedIn.get(p.account_id) ?? new Set()).add(y))
    }
  }

  // Book depreciation per server and year: the 1650 leg of each posted actual-book entry, dated
  // through year end, that also posts to depreciation expense. A disposal (1650 against cost and
  // the gain) is not depreciation and never touches expense, so it is not counted.
  const expenseIds = new Set(depreciationAccounts.map(a => a.id))
  const accumulatedIds = assets.map(l => l.accumulatedAccountId).filter((id): id is string => !!id)
  // Chunked (a fleet's 1650 accounts, sold servers' included, outgrow one URL), and every chunk is
  // read before `expensed` is built: an entry's expense leg and its 1650 leg can land in different chunks.
  const movements = accumulatedIds.length && expenseIds.size
    ? (await fetchAllRowsIn<any>([...expenseIds, ...accumulatedIds], (chunk, f, t) => (admin as any).from('journal_postings')
        .select('journal_entry_id, account_id, amount, journal_entries!inner(entry_date, status, book)')
        .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('book', 'actual')
        .in('account_id', chunk).range(f, t)))
      .filter(r => r.journal_entries?.status === 'posted' && r.journal_entries?.book === 'actual' && String(r.journal_entries?.entry_date) <= yearEnd)
    : []
  const expensed = new Set(movements.filter(r => expenseIds.has(r.account_id)).map(r => r.journal_entry_id))
  const bookByAccount = new Map<string, Map<number, number>>()
  for (const r of movements) {
    if (expenseIds.has(r.account_id) || !expensed.has(r.journal_entry_id)) continue
    const byYear = bookByAccount.get(r.account_id) ?? new Map<number, number>()
    const y = yearOf(String(r.journal_entries.entry_date))
    byYear.set(y, (byYear.get(y) ?? 0) - cents(r.amount))
    bookByAccount.set(r.account_id, byYear)
  }

  const out: FleetTaxYear = { depreciation: [], disposals: [], unposted: [], laterDisposals: [] }
  for (const l of assets) {
    const a = l.asset
    const acct = l.accumulatedAccountId
    if (!l.purchase || !acct || !a.in_service_date || a.tax_method === 'book') continue
    if (a.disposed_on && a.disposed_on < yearStart) continue
    const tax = taxDepreciationByYear(l)
    const book = bookByAccount.get(acct) ?? new Map<number, number>()
    const bookInYear = book.get(taxYear) ?? 0
    const taxInYear = tax.get(taxYear) ?? 0
    const line = (bookC: number, taxC: number): FleetDepreciationDifference => ({
      assetId: a.id, name: a.name, accumulatedAccountId: acct,
      book: dollars(bookC), tax: dollars(taxC), difference: dollars(taxC - bookC),
    })
    if (taxInYear !== bookInYear) out.depreciation.push(line(bookInYear, taxInYear))
    // The tax book credits 1650 by the difference, so what a year holds as a difference is its negation.
    const held = (y: number) => 0 - (overlay.get(acct)?.get(y) ?? 0)

    if (a.disposed_on && a.disposed_on <= yearEnd) {
      const sumTo = (m: Map<number, number>) => Array.from(m.entries()).filter(([y]) => y <= taxYear).reduce((t, [, c]) => t + c, 0)
      const bookToDate = sumTo(book)
      const taxToDate = sumTo(tax)
      if (taxToDate !== bookToDate) out.disposals.push(line(bookToDate, taxToDate))
      const earlier = new Set([...book.keys(), ...tax.keys(), ...(overlay.get(acct)?.keys() ?? [])].filter(y => y < taxYear))
      for (const y of Array.from(earlier).sort()) {
        const expected = (tax.get(y) ?? 0) - (book.get(y) ?? 0)
        if (held(y) !== expected) out.unposted.push({ assetId: a.id, name: a.name, taxYear: y, expected: dollars(expected), posted: dollars(held(y)) })
      }
    } else if (held(taxYear) !== taxInYear - bookInYear) {
      for (const y of Array.from(clearedIn.get(acct) ?? []).filter(y => y > taxYear).sort()) {
        out.laterDisposals.push({ taxYear: y, assetId: a.id, name: a.name })
      }
    }
  }
  return out
}

/** Why the run refuses when a disposed server's earlier differences are not in the tax book, and what to do. */
export function unpostedOverlayError(gaps: FleetOverlayGap[], taxYear: number): string {
  const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const years = Array.from(new Set(gaps.map(g => g.taxYear))).sort()
  const detail = gaps.map(g => `${g.name} ${g.taxYear}: difference ${fmt(g.expected)}, tax book holds ${fmt(g.posted)}`).join('; ')
  return (
    `The tax book does not hold the earlier depreciation differences of a server disposed of in ${taxYear} (${detail}). ` +
    `Clearing them on disposal would leave a balance on a sold server. Run the book-to-tax adjustments for ` +
    `${years.join(', ')} first, in order, then rerun ${taxYear}.`
  )
}
