import type { SupabaseClient } from '@supabase/supabase-js'
import { reviewImport, type ImportReview } from '@/lib/accounting/import-review'
import { ensureVehicleAccounts } from '@/lib/accounting/provision-accounts'
import { chartForVehicleKind } from '@/lib/accounting/chart'
import { vehicleKindByName } from '@/lib/accounting/vehicle-domain'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { accountIdByCode, persistEntry } from '@/lib/accounting/persist'
import { BULK_BATCH } from '@/lib/accounting/journal-bulk'
import { buildEntries, qbVendorName } from './build-entries'
import { proposeMapping, type ChartAccount } from './propose-mapping'
import type { QbAccountSummary, QbTransaction } from './parse-journal'
import { normalizeVendorName, vendorResolver } from '@/lib/accounting/vendors'
import { bookConflicts, matchImported, type BookConflict, type BookEntry, type DuplicateTransaction, type RecoveredTransaction } from './dedupe'
import { ACTUAL_BOOK, LEDGER_BOOKS, isLedgerBook, type LedgerBook } from '@/lib/accounting/books'
import { closedTaxYears } from '@/lib/tax/year-close'
import { bookForTransaction, lockedTaxYear, taxAccountHit } from './book-routing'
import type { JournalSource } from './sources'
import type { JournalEntry } from '@/lib/accounting/types'

/**
 * The QuickBooks migration's three steps — propose a mapping, save it, import as drafts — as
 * functions, so the web routes and the agent tools run the identical path. Same reason
 * bank-import.ts exists: a connector feeding QuickBooks over MCP must land exactly where a person
 * pasting the Journal export lands, review hold and all.
 *
 * Every function takes transactions that are ALREADY parsed or normalized (parseQbJournal or
 * normalizeQbTransactions). Where they came from is the caller's business — except WHOSE books
 * they are, which `source` says (sources.ts): QuickBooks and Carta keep separate mappings and
 * separate provenance on the entries they create.
 */

export class QbImportError extends Error {
  constructor(message: string, readonly status = 500) { super(message) }
}

/** Step 1: propose a mapping for the accounts these transactions touch. Writes nothing. */
export async function proposeQbAccounts(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  parsed: { transactions: QbTransaction[]; accounts: QbAccountSummary[]; errors: string[] },
  source: JournalSource = 'quickbooks',
) {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const { transactions, accounts, errors } = parsed

  const [{ data: chartRows, error: chartError }, { data: savedRows, error: savedError }] = await Promise.all([
    admin.from('chart_of_accounts' as any)
      .select('id, code, name, type, subtype, company_id, lp_entity_id, is_active')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId),
    (admin as any).from('qb_account_mappings')
      .select('qb_account, account_code, excluded, tax_book')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('source', source),
  ])
  if (chartError || savedError) throw new QbImportError(chartError?.message ?? savedError?.message)

  const chart = ((chartRows as any[]) ?? []) as ChartAccount[]
  const kind = await vehicleKindByName(admin, fundId, group)
  for (const a of chartForVehicleKind(kind)) {
    if (!chart.some(existing => existing.code === a.code)) chart.push({ ...a, id: `template:${a.code}`, is_active: true } as ChartAccount)
  }
  const saved = new Map(((savedRows as any[]) ?? []).map(r => [r.qb_account, r]))

  // A previously CONFIRMED mapping always wins over a fresh proposal — see the migration's
  // comment on why re-proposing between passes would move balances for no visible reason.
  // The tax-book flag is kept even when the saved code no longer resolves: it is a statement about
  // the source account, not about where it maps.
  const proposals = proposeMapping(accounts, chart).map(p => {
    const prior = saved.get(p.qbAccount)
    if (!prior) return { ...p, taxBook: false }
    const taxBook = !prior.excluded && !!prior.tax_book
    if (!prior.excluded && !chart.some(a => a.code === prior.account_code && a.is_active !== false)) return { ...p, taxBook }
    return {
      ...p,
      code: prior.account_code ?? null,
      excluded: !!prior.excluded,
      taxBook,
      confidence: 'exact' as const,
      reason: prior.excluded ? 'Excluded from import (saved).' : 'Confirmed previously.',
    }
  })

  const dates = transactions.map(t => t.date).sort()

  return {
    group,
    source,
    transactionCount: transactions.length,
    dateRange: dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null,
    accounts: proposals.map(p => ({ ...p, lineCount: accounts.find(a => a.account === p.qbAccount)?.lineCount ?? 0 })),
    mappedCount: proposals.filter((p: any) => p.code && !p.excluded).length,
    excludedCount: proposals.filter((p: any) => p.excluded).length,
    taxBookCount: proposals.filter(p => p.taxBook).length,
    discoveredHoldings: Array.from(new Set(proposals.map(p => p.suggestsHolding).filter(Boolean))),
    errors,
  }
}

export interface QbMappingRow {
  qbAccount: string
  accountCode?: string | null
  excluded?: boolean
  /**
   * The source account is kept on a tax basis only (a preparer's K-1 entries). Transactions
   * touching it import into the tax book, whole (book-routing.ts). Ignored when excluded.
   */
  taxBook?: boolean
  note?: string | null
}

/** Step 2: save confirmed mapping rows. Every mapped code must be an active account on the vehicle. */
export async function saveQbMappings(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  input: QbMappingRow[],
  source: JournalSource = 'quickbooks',
): Promise<{ saved: number }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)

  const valid = input.filter((r: any) => typeof r?.qbAccount === 'string' && r.qbAccount.trim())
  if (valid.length === 0) return { saved: 0 }

  // A row that does not mention taxBook keeps the flag it has. A caller written before the flag
  // existed (a connector re-saving one mapping, say) must not silently send a tax-only account's
  // K-1 entries back into the actual ledger.
  const { data: priorRows, error: priorError } = await (admin as any).from('qb_account_mappings')
    .select('qb_account, tax_book')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('source', source)
  if (priorError) throw new QbImportError(priorError.message)
  const priorTax = new Set(((priorRows as any[]) ?? []).filter(r => r.tax_book).map(r => r.qb_account as string))

  const rows = valid.map((r: any) => ({
    fund_id: fundId,
    vehicle_id: vehicleId,
    source,
    qb_account: r.qbAccount.trim(),
    account_code: r.accountCode ?? null,
    excluded: !!r.excluded,
    tax_book: !r.excluded && (typeof r.taxBook === 'boolean' ? r.taxBook : priorTax.has(r.qbAccount.trim())),
    note: r.note ?? null,
    updated_at: new Date().toISOString(),
  }))

  const { data: chart, error: chartError } = await admin.from('chart_of_accounts' as any)
    .select('code, is_active').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
  if (chartError) throw new QbImportError(chartError.message)
  const codes = new Set(((chart as any[]) ?? []).filter(a => a.is_active !== false).map(a => a.code))
  const existingCodes = new Set(((chart as any[]) ?? []).map(a => a.code))
  const kind = await vehicleKindByName(admin, fundId, group)
  for (const account of chartForVehicleKind(kind)) if (!existingCodes.has(account.code)) codes.add(account.code)
  const invalid = rows.find((r: any) => !r.excluded && (!r.account_code || !codes.has(r.account_code)))
  if (invalid) throw new QbImportError(`Choose an active account on ${group} for "${invalid.qb_account}".`, 400)

  const { error } = await (admin as any).from('qb_account_mappings')
    .upsert(rows, { onConflict: 'fund_id,vehicle_id,source,qb_account' })
  if (error) throw new QbImportError(error.message)

  return { saved: rows.length }
}

export interface QbImportParams {
  fundId: string
  group: string
  /** Whose books these are. Defaults to QuickBooks. */
  source?: JournalSource
  userId: string | null
  transactions: QbTransaction[]
  /** Problems found while parsing or normalizing; carried into the result and the run log. */
  parseErrors: string[]
  dryRun: boolean
  reviewToken?: string | null
  /** Whether the caller may see LP capital — widens the comparison with LP records. */
  includeLp: boolean
  sourceLabel?: string | null
}

export interface TaxBookSummary {
  /** Tax-book entries created by this run (would be, on a dry run). */
  entries: number
  /** The source accounts flagged tax-book in the mapping. */
  accounts: string[]
  /** Each new tax-book entry and the flagged account that sent it there. */
  routed: { entryDate: string; memo: string | null; account: string }[]
  /** Tax-routed transactions refused because their tax year is closed (lib/tax/year-close.ts). */
  lockedYears: { entryDate: string; memo: string | null; taxYear: number }[]
}

export type QbImportResult =
  | {
      dryRun: true
      importReview: ImportReview
      transactionsParsed: number
      wouldCreate: number
      alreadyPresent: number
      skipped: number
      /** Each transaction counted in alreadyPresent, with the entry it matched and why (dedupe.ts). */
      duplicates: DuplicateTransaction[]
      /** Imported although an entry under its pre-payee ref exists — the ones an older import dropped. */
      recovered: RecoveredTransaction[]
      /** What went, or would go, to the tax book (book-routing.ts). Included in the counts above. */
      taxBook: TaxBookSummary
      /** Already imported into the other book from the one the mapping now routes them to; left alone. */
      bookConflicts: BookConflict[]
      errors: string[]
      capitalWarnings: string[]
    }
  | {
      dryRun?: false
      importReview: ImportReview
      transactionsParsed: number
      created: number
      alreadyPresent: number
      skipped: number
      duplicates: DuplicateTransaction[]
      recovered: RecoveredTransaction[]
      taxBook: TaxBookSummary
      bookConflicts: BookConflict[]
      errors: string[]
      capitalWarnings: string[]
    }
  /** The comparison found differences and no matching token was supplied. Nothing was written. */
  | { reviewRequired: true; error: string; importReview: ImportReview }

/**
 * Step 3: import as DRAFT journal entries.
 *
 * NOTHING POSTS. Every entry is reviewed on the journal page and posted through the existing
 * bulk-post surface — an import that posted directly would need REVERSING when a mapping turns
 * out wrong, instead of simply being re-run.
 *
 * Idempotent by `source_ref = qb:v2:<hash>`: re-importing after fixing one mapping updates the
 * count of matched entries rather than duplicating the ledger. That is also what makes a
 * scheduled connector safe to re-send overlapping windows. Entries written under the first,
 * payee-blind ref are still recognised, by count — see dedupe.ts.
 *
 * TWO BOOKS. A transaction touching a source account mapped `taxBook` goes to the tax book, whole
 * (book-routing.ts): a preparer's K-1 entries in a tax-basis QuickBooks file are book-to-tax
 * differences, not fair-value events. Dedupe looks in both books, and a transaction already in the
 * other book is reported in `bookConflicts`, never moved. A tax-routed transaction dated in a
 * closed tax year is refused and named (`taxBook.lockedYears`).
 */
export async function importQbJournal(admin: SupabaseClient, params: QbImportParams): Promise<QbImportResult> {
  const { fundId, group, userId, transactions, parseErrors, dryRun } = params
  const source = params.source ?? 'quickbooks'
  const vehicleId = await vehicleIdByName(admin, fundId, group)

  const { data: mappingRows, error: mappingError } = await (admin as any).from('qb_account_mappings')
    .select('qb_account, account_code, excluded, tax_book')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('source', source)

  if (mappingError) throw new QbImportError(mappingError.message)

  const mapping = new Map<string, string>()
  const excluded = new Set<string>()
  const taxAccounts = new Set<string>()
  for (const r of ((mappingRows as any[]) ?? [])) {
    if (r.excluded) { excluded.add(r.qb_account); continue }
    if (r.account_code) mapping.set(r.qb_account, r.account_code)
    if (r.tax_book) taxAccounts.add(r.qb_account)
  }

  // A transaction touching an excluded account is dropped whole — importing half of a
  // double-entry transaction would post something that does not balance.
  const skippedForExclusion: string[] = []
  const importable = transactions.filter(t => {
    const hit = t.lines.find(l => excluded.has(l.account))
    if (!hit) return true
    skippedForExclusion.push(`${t.type ?? 'Transaction'} ${t.num ?? t.date}: touches excluded account "${hit.account}".`)
    return false
  })

  const accountIds = await accountIdByCode(admin, fundId, group)

  const previewAccounts = []
  {
    const kind = await vehicleKindByName(admin, fundId, group)
    for (const a of chartForVehicleKind(kind)) if (!accountIds.has(a.code)) {
      accountIds.set(a.code, `template:${a.code}`)
      previewAccounts.push({ ...a, id: `template:${a.code}`, fundId })
    }
  }

  // Create vendors only during the confirmed import. A preview never changes records.
  const resolveVendor = vendorResolver(admin, fundId)
  const vendorIdByName = new Map<string, string>()

  // Chart accounts provide both membership and the dedicated capital destination. Never
  // search the tenant-wide LP list: the same person can invest in several vehicles.
  const { data: capitalRows, error: capitalError } = await admin.from('chart_of_accounts' as any)
    .select('id, code, lp_entity_id, lp_entities(entity_name)')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId)
    .eq('type', 'equity').eq('subtype', 'lp_capital').eq('is_active', true)
  if (capitalError) throw new QbImportError(capitalError.message)
  const rows = (capitalRows ?? []) as any[]
  const { entries, origins, skipped, capitalWarnings } = buildEntries(importable, mapping, accountIds, fundId, vendorIdByName, {
    accountIds: new Set(rows.filter(r => !r.lp_entity_id).map(r => r.id)),
    targets: rows.filter(r => r.lp_entity_id && r.lp_entities?.entity_name).map(r => ({
      entityId: r.lp_entity_id, name: r.lp_entities.entity_name, accountId: r.id,
    })),
  }, source)

  // Which book each entry goes to: the tax book when its transaction touches a tax-book account,
  // whole (book-routing.ts). Aligned with `entries`.
  const books: LedgerBook[] = origins.map(o => bookForTransaction(o.transaction, taxAccounts))

  // Which of these have we already imported? Under the current ref or the first-version one
  // (dedupe.ts). Batched: a decade of history is thousands of refs, and one .in() of that size
  // fails. No status filter — a voided entry still blocks re-import, deliberately. Every book: a
  // transaction already in the other book is already imported (dedupe.ts, "BOTH BOOKS").
  const refs = Array.from(new Set(entries.flatMap((e, i) => [e.sourceRef!, origins[i].legacyRef])))
  const book: BookEntry[] = []
  for (let i = 0; i < refs.length; i += BULK_BATCH) {
    const chunk = refs.slice(i, i + BULK_BATCH)
    const { data, error } = await admin.from('journal_entries' as any)
      .select('id, source_ref, status, book, vendor_id, journal_postings(lp_entity_id)')
      .in('book', LEDGER_BOOKS)
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .in('source_ref', chunk)
    if (error) throw new QbImportError(error.message)
    for (const r of ((data as any[]) ?? [])) book.push({
      id: r.id, sourceRef: r.source_ref, status: r.status, vendorId: r.vendor_id ?? null,
      book: isLedgerBook(r.book) ? r.book : ACTUAL_BOOK,
      lpEntityIds: ((r.journal_postings as any[]) ?? []).map(p => p.lp_entity_id).filter(Boolean),
    })
  }
  // An old entry's payee is a vendor id. Look the incoming names up — never create them here.
  const existingVendors = new Map<string, string>()
  if (book.some(b => b.vendorId)) {
    const { data, error } = await admin.from('vendors' as any).select('id, name').eq('fund_id', fundId)
    if (error) throw new QbImportError(error.message)
    for (const v of ((data as any[]) ?? [])) existingVendors.set(normalizeVendorName(v.name).toLowerCase(), v.id)
  }
  const candidates = entries.map((e, i) => {
    const payee = qbVendorName(origins[i].transaction)
    return {
      ref: e.sourceRef!, legacyRef: origins[i].legacyRef, entryDate: e.entryDate, memo: e.memo ?? null, payee,
      vendorId: payee ? existingVendors.get(normalizeVendorName(payee).toLowerCase()) ?? null : null,
      lpEntityIds: e.postings.map(p => p.lpEntityId).filter((id): id is string => !!id),
      book: books[i],
    }
  })
  const { present, duplicates, recovered } = matchImported(candidates, book)
  const conflicts = bookConflicts(candidates, duplicates)

  // The tax book's lock is the tax YEAR (lib/tax/year-close.ts); the database refuses a tax-book
  // write dated in a closed one. Name those here, dry run included, rather than letting the
  // trigger fail them one by one. The actual book's closed periods are persistEntry's to report.
  let closedYears = new Set<number>()
  if (books.includes('tax')) {
    try { closedYears = await closedTaxYears(admin, fundId, vehicleId as string) } catch (e) { throw new QbImportError((e as Error).message) }
  }
  const lockedYears: TaxBookSummary['lockedYears'] = []
  const routed: TaxBookSummary['routed'] = []
  const bookOfEntry = new Map<JournalEntry, LedgerBook>()
  const toCreate = entries.filter((e, i) => {
    if (present[i]) return false
    if (books[i] === 'tax') {
      const year = lockedTaxYear(e.entryDate, closedYears)
      if (year !== null) { lockedYears.push({ entryDate: e.entryDate, memo: e.memo ?? null, taxYear: year }); return false }
      routed.push({ entryDate: e.entryDate, memo: e.memo ?? null, account: taxAccountHit(origins[i].transaction, taxAccounts)! })
    }
    bookOfEntry.set(e, books[i])
    return true
  })
  const bookFor = (e: JournalEntry) => bookOfEntry.get(e) ?? ACTUAL_BOOK
  const taxRouted = toCreate.filter(e => bookFor(e) === 'tax')
  const writeErrors: string[] = [
    ...parseErrors, ...skippedForExclusion, ...skipped.map(s => s.reason),
    ...lockedYears.map(l => `${l.entryDate} ${l.memo ?? ''}: routed to the tax book, but tax year ${l.taxYear} is closed. Reopen it on the Tax page to import this.`),
  ]
  const taxBook = (n: number): TaxBookSummary => ({ entries: n, accounts: Array.from(taxAccounts).sort(), routed, lockedYears })

  // The comparison with investment and LP records is a comparison of the ACTUAL book: a tax-book
  // entry moves neither investment cost nor partners' book capital, so it is left out of it.
  const importReview = await reviewImport(admin, fundId, group, { entries: toCreate.filter(e => bookFor(e) === ACTUAL_BOOK), previewAccounts, includeLp: params.includeLp })
  if (!dryRun && importReview.differences.length && params.reviewToken !== importReview.token) {
    return { reviewRequired: true, error: 'Review the differences with investment and LP records before importing.', importReview }
  }

  if (dryRun) {
    return {
      dryRun: true,
      importReview,
      transactionsParsed: transactions.length,
      wouldCreate: toCreate.length,
      alreadyPresent: entries.length - toCreate.length - lockedYears.length,
      skipped: skipped.length + skippedForExclusion.length + lockedYears.length,
      duplicates,
      recovered,
      taxBook: taxBook(taxRouted.length),
      bookConflicts: conflicts,
      errors: writeErrors,
      capitalWarnings,
    }
  }

  await ensureVehicleAccounts(admin, fundId, group)
  const actualIds = await accountIdByCode(admin, fundId, group)
  for (const entry of toCreate) for (const posting of entry.postings) {
    if (posting.accountId.startsWith('template:')) posting.accountId = actualIds.get(posting.accountId.slice(9))!
  }
  // Vendor creation is also a write and follows the comparison.
  for (const name of Array.from(new Set(importable.map(qbVendorName).filter((n): n is string => !!n)))) {
    const id = await resolveVendor(name)
    if (id) vendorIdByName.set(name.toLowerCase(), id)
  }
  const withVendors = buildEntries(importable, mapping, actualIds, fundId, vendorIdByName, undefined, source)
  for (const entry of toCreate) entry.vendorId = withVendors.entries.find(e => e.sourceRef === entry.sourceRef)?.vendorId
  let created = 0
  let createdTax = 0
  for (const entry of toCreate) {
    // Drafts in either book. A tax-book draft is posted or discarded from the journal's Tax book
    // view (journal-bulk.ts); posting it never allocates to partners, since allocation is an
    // actual-book operation (persist.ts, continuous-allocation.ts).
    const target = bookFor(entry)
    const result = await persistEntry(admin, fundId, group, userId, entry, 'draft', target)
    if ('error' in result) {
      // persistEntry refuses to write into a closed period. During a migration that is a real
      // possibility, so surface it as a named skip rather than a failed run.
      writeErrors.push(`${entry.entryDate} ${entry.memo ?? ''}: ${result.error}`)
      continue
    }
    created += 1
    if (target === 'tax') createdTax += 1
  }

  await (admin as any).from('qb_import_runs').insert({
    fund_id: fundId,
    vehicle_id: vehicleId,
    source,
    source_label: params.sourceLabel ?? null,
    reconciliation_review: { ...importReview, differences: importReview.differences.filter(d => d.domain !== 'lp'), lpDifferences: importReview.differences.filter(d => d.domain === 'lp').length },
    transactions_parsed: transactions.length,
    entries_created: created,
    entries_matched: entries.length - toCreate.length - lockedYears.length,
    transactions_skipped: skipped.length + skippedForExclusion.length + lockedYears.length,
    errors: writeErrors.length ? writeErrors : null,
    created_by: userId,
  })

  return {
    importReview,
    transactionsParsed: transactions.length,
    created,
    alreadyPresent: entries.length - toCreate.length - lockedYears.length,
    skipped: skipped.length + skippedForExclusion.length + lockedYears.length,
    duplicates,
    recovered,
    taxBook: taxBook(createdTax),
    bookConflicts: conflicts,
    errors: writeErrors,
    capitalWarnings,
  }
}
